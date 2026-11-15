import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";

for (const k of ["SUPABASE_URL","SUPABASE_ANON_KEY","SUPABASE_SERVICE_ROLE_KEY","CLIENT_ORIGIN"]) if (!process.env[k]) throw Error("Missing " + k);
function normalizedSupabaseUrl(raw: string): string {
  const input = raw.trim().replace(/^["']|["']$/g, "");
  const url = new URL(input);
  if (url.protocol !== "https:") throw Error("SUPABASE_URL must use HTTPS");
  if (url.pathname !== "/" || url.search || url.hash) {
    console.warn("SUPABASE_URL contains an unexpected path or query; using project origin only.");
  }
  return url.origin;
}
const supabaseUrl = normalizedSupabaseUrl(process.env.SUPABASE_URL!);
console.log("Supabase API configured", { host: new URL(supabaseUrl).hostname });
const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const auth = createClient(supabaseUrl, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
const app = express();
// Normalize Render origin settings (trailing slashes and accidental quotes are common).
const allowedOrigins = new Set([
  process.env.CLIENT_ORIGIN!,
  "https://relay-web-ywvk.onrender.com"
].map(value => value.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "")));
const corsOptions = {
  origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
    // Non-browser clients (e.g. health checks) do not send Origin.
    if (!origin || allowedOrigins.has(origin.replace(/\/+$/, ""))) return callback(null, true);
    callback(new Error("Origin not allowed: " + origin));
  }
};
app.use(cors(corsOptions));
app.use(express.json({ limit: "3mb" }));
const server = createServer(app);
const io = new Server(server, { cors: corsOptions });
type AuthReq = Request & { userId?: string };
const rateBuckets=new Map<string,{count:number;reset:number}>();
function limitRate(key:string,max:number,windowMs:number):boolean {
  const now=Date.now();
  if(rateBuckets.size>20000)for(const [k,v] of rateBuckets)if(v.reset<=now)rateBuckets.delete(k);
  const bucket=rateBuckets.get(key);
  if(!bucket||bucket.reset<=now){rateBuckets.set(key,{count:1,reset:now+windowMs});return true;}
  if(bucket.count>=max)return false;
  bucket.count++;return true;
}
const filePayload=z.object({name:z.string().min(1).max(120),mime:z.string().min(1).max(100),data:z.string().min(1).max(2800000)});
const allowedMimes=new Set(["image/png","image/jpeg","image/webp","image/gif","application/pdf","text/plain"]);
async function storeFile(userId:string,kind:"avatars"|"attachments",payload:unknown) {
  const parsed=filePayload.safeParse(payload);
  if(!parsed.success)throw Error("Invalid file");
  const {name,mime,data}=parsed.data;
  if(!allowedMimes.has(mime))throw Error("Unsupported file type. Use images, PDF or plain text.");
  const bytes=Buffer.from(data,"base64");
  if(!bytes.length||bytes.length>2*1024*1024)throw Error("File must be under 2 MB.");
  const ext=({ "image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif","application/pdf":"pdf","text/plain":"txt"} as Record<string,string>)[mime];
  const path=userId+"/"+crypto.randomUUID()+"."+ext;
  const {error}=await admin.storage.from("relay-files").upload(path,bytes,{contentType:mime,upsert:false});
  if(error)throw error;
  return {path,name:name.replace(/[\\/<>]/g,"_"),mime};
}
async function signedFile(path:string) {
  const {data,error}=await admin.storage.from("relay-files").createSignedUrl(path,3600);
  if(error)throw error;
  return data.signedUrl;
}
const safe = (fn: (req: AuthReq, res: Response) => Promise<void>) => (req: AuthReq, res: Response, next: NextFunction) => { Promise.resolve(fn(req,res)).catch(next); };
async function userFor(token: string) {
  const { data, error } = await auth.auth.getUser(token);
  if (error || !data.user) {
    console.error("Supabase token validation failed", {
      message: error?.message ?? "No user returned",
      status: error?.status ?? null,
      code: error?.code ?? null,
      configuredProjectHost: new URL(supabaseUrl).hostname
    });
    throw Error("Unauthorized");
  }
  return data.user.id;
}
const guard = async (req: AuthReq, res: Response, next: NextFunction) => {
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw Error("No token");
    req.userId = await userFor(token); next();
  } catch { res.status(401).json({ error: "Unauthorized" }); }
};
async function member(conversationId: string, userId: string) {
  const { data, error } = await admin.from("conversation_members").select("user_id").eq("conversation_id",conversationId).eq("user_id",userId).maybeSingle();
  if (error) throw error;
  return !!data;
}
app.get("/health",(_req,res) => res.json({ ok:true }));
app.get("/api/files",guard,safe(async(req,res) => {
  const path=z.string().min(1).max(250).parse(req.query.path);
  if(!path.startsWith(req.userId!+"/")) {
    const {data:messages,error}=await admin.from("messages").select("conversation_id").eq("attachment_path",path).limit(10);
    if(error)throw error;
    let authorized=false;
    for(const m of messages??[])if(await member(m.conversation_id,req.userId!)){authorized=true;break;}
    if(!authorized){
      const {data:avatar}=await admin.from("profiles").select("id").eq("avatar_path",path).maybeSingle();
      if(!avatar){res.status(403).json({error:"File access denied"});return;}
    }
  }
  res.json({url:await signedFile(path)});
}));
app.post("/api/me/avatar",guard,safe(async(req,res) => {
  if(!limitRate("avatar:"+req.userId,10,60*60*1000)){res.status(429).json({error:"Too many uploads. Try again later."});return;}
  const {mime}=req.body??{};
  if(!["image/png","image/jpeg","image/webp","image/gif"].includes(mime)){res.status(400).json({error:"Choose a PNG, JPG, WebP or GIF image."});return;}
  try{
    const file=await storeFile(req.userId!,"avatars",req.body);
    const {error}=await admin.from("profiles").update({avatar_path:file.path}).eq("id",req.userId!);
    if(error)throw error;
    io.emit("profiles:updated");
    res.json({path:file.path,url:await signedFile(file.path)});
  }catch(e){res.status(400).json({error:(e as Error).message});}
}));
app.get("/api/users/search",guard,safe(async(req,res)=>{
 const q=z.string().trim().toLowerCase().regex(/^[a-z0-9_]{2,24}$/).parse(req.query.q);
 if(!limitRate("search:"+req.userId,90,60000)){res.status(429).json({error:"Search limit reached"});return;}
 const {data,error}=await admin.from("profiles").select("id,username,avatar_path").ilike("username",q.replace(/_/g,"\\_")+"%").neq("id",req.userId!).order("username").limit(15);
 if(error)throw error;
 res.json(data??[]);
}));
app.get("/api/friends",guard,safe(async(req,res)=>{
 const {data,error}=await admin.from("relay_friends").select("*").or("requester.eq."+req.userId+",recipient.eq."+req.userId);if(error)throw error;
 const ids=(data??[]).map(x=>x.requester===req.userId?x.recipient:x.requester);
 const people=ids.length?await admin.from("profiles").select("id,username,avatar_path").in("id",ids):{data:[],error:null};if(people.error)throw people.error;
 res.json((data??[]).map(x=>({...x,person:people.data?.find(p=>p.id===(x.requester===req.userId?x.recipient:x.requester))})));
}));
app.post("/api/friends",guard,safe(async(req,res)=>{
 const id=z.string().uuid().parse(req.body.id);if(id===req.userId){res.status(400).json({error:"Cannot add yourself"});return;}
 if(!limitRate("friend:"+req.userId,30,3600000)){res.status(429).json({error:"Too many requests"});return;}
 const {error}=await admin.from("relay_friends").insert({requester:req.userId,recipient:id});if(error&&error.code!=="23505")throw error;
 io.to("user:"+id).emit("friends:changed");res.json({ok:true});
}));
app.patch("/api/friends/:id",guard,safe(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);const {error}=await admin.from("relay_friends").update({accepted:true}).eq("requester",id).eq("recipient",req.userId!);if(error)throw error;io.to("user:"+id).emit("friends:changed");res.json({ok:true});
}));
app.delete("/api/friends/:id",guard,safe(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);const {error}=await admin.from("relay_friends").delete().or("and(requester.eq."+req.userId+",recipient.eq."+id+"),and(requester.eq."+id+",recipient.eq."+req.userId+")");if(error)throw error;io.to("user:"+id).emit("friends:changed");res.json({ok:true});
}));
app.post("/api/messages/:id/reactions",guard,safe(async(req,res)=>{
 const id=z.string().uuid().parse(req.params.id);const emoji=z.enum(["👍","❤️","😂","🔥","🎉","😮"]).parse(req.body.emoji);
 const {data:m,error}=await admin.from("messages").select("conversation_id").eq("id",id).single();if(error)throw error;if(!await member(m.conversation_id,req.userId!)){res.status(403).json({error:"Forbidden"});return;}
 if(!limitRate("reaction:"+req.userId,120,60000)){res.status(429).json({error:"Too many reactions"});return;}
 const q=admin.from("relay_reactions");const {data:existing,error:e}=await q.select("message_id").eq("message_id",id).eq("user_id",req.userId!).eq("emoji",emoji).maybeSingle();if(e)throw e;
 const result=existing?await admin.from("relay_reactions").delete().eq("message_id",id).eq("user_id",req.userId!).eq("emoji",emoji):await admin.from("relay_reactions").insert({message_id:id,user_id:req.userId,emoji});if(result.error)throw result.error;
 const rows=await admin.from("relay_reactions").select("user_id,emoji").eq("message_id",id);if(rows.error)throw rows.error;io.to("conversation:"+m.conversation_id).emit("reactions:changed",{id,conversationId:m.conversation_id,reactions:rows.data});res.json(rows.data);
}));
app.get("/api/me",guard,safe(async(req,res) => {
  const {data,error} = await admin.from("profiles").select("id,username,avatar_path,created_at,bio,status").eq("id",req.userId!).maybeSingle();
  if (error) throw error;
  if (!data) { res.status(404).json({error:"Profile missing. Run the profile backfill migration in Supabase."}); return; }
  res.json(data);
}));
app.patch("/api/me",guard,safe(async(req,res) => {
  const parsed = z.object({username:z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/),bio:z.string().trim().max(180).optional(),status:z.string().trim().max(80).optional()}).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({error:"Username must be 3–24 letters, numbers or underscores."}); return; }
  const {data,error} = await admin.from("profiles").update({username:parsed.data.username,bio:parsed.data.bio,status:parsed.data.status}).eq("id",req.userId!).select("id,username,bio,status").single();
  if (error) {
    if (error.code === "23505") { res.status(409).json({error:"That username is already taken."}); return; }
    throw error;
  }
  io.emit("profiles:updated");
  res.json(data);
}));
app.post("/api/groups",guard,safe(async(req,res)=>{
 const parsed=z.object({name:z.string().trim().min(1).max(60),usernames:z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/)).min(2).max(19)}).parse(req.body);
 if(!limitRate("group:"+req.userId,10,3600000)){res.status(429).json({error:"Group creation limit reached"});return;}
 const names=[...new Set(parsed.usernames)];
 const {data:people,error}=await admin.from("profiles").select("id,username").in("username",names);
 if(error)throw error;
 const ids=[...new Set([req.userId!,...(people??[]).map(p=>p.id)])];
 if(people?.length!==names.length||ids.length<3){res.status(400).json({error:"Enter at least two distinct existing usernames other than your own."});return;}
 const {data:group,error:ge}=await admin.from("conversations").insert({name:parsed.name}).select("id").single();
 if(ge)throw ge;
 const {error:me}=await admin.from("conversation_members").insert(ids.map(id=>({conversation_id:group.id,user_id:id})));
 if(me){await admin.from("conversations").delete().eq("id",group.id);throw me;}
 for(const id of ids)io.to("user:"+id).emit("conversations:refresh");
 res.status(201).json(group);
}));
app.get("/api/conversations",guard,safe(async(req,res) => {
  const { data: mine, error } = await admin.from("conversation_members").select("conversation_id").eq("user_id",req.userId!);
  if (error) throw error;
  const ids = (mine ?? []).map(m => m.conversation_id);
  if (!ids.length) { res.json([]); return; }
  const { data: all, error: e } = await admin.from("conversation_members").select("conversation_id,user_id,last_read_at,profiles(username,avatar_path,bio,status)").in("conversation_id",ids);
  if (e) throw e;
  const {data:details,error:de}=await admin.from("conversations").select("id,name").in("id",ids);
  if(de)throw de;
  res.json(ids.map(id => ({ id, name:details?.find(d=>d.id===id)?.name??null, members:(all ?? []).filter(m => m.conversation_id === id).map(m => ({ id:m.user_id, username:(m.profiles as any)?.username ?? "Unknown", avatar_path:(m.profiles as any)?.avatar_path ?? null, last_read_at:m.last_read_at ?? null, bio:(m.profiles as any)?.bio??"",status:(m.profiles as any)?.status??"",online:io.sockets.adapter.rooms.has("user:"+m.user_id) })) })));
}));
app.post("/api/conversations",guard,safe(async(req,res) => {
  const parsed = z.object({ username:z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/),bio:z.string().trim().max(180).optional(),status:z.string().trim().max(80).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({error:"Enter the Relay username (not an email): 3–24 lowercase letters, numbers or underscores. Check the username in Supabase public.profiles."});
    return;
  }
  const { username } = parsed.data;
  const { data: target, error: e } = await admin.from("profiles").select("id").eq("username",username).maybeSingle();
  if (e) throw e;
  if (!target) { res.status(404).json({error:"Username not found"}); return; }
  if (target.id === req.userId) { res.status(400).json({error:"Cannot chat with yourself"}); return; }
  const { data: ownProfile, error: profileError } = await admin.from("profiles").select("id").eq("id",req.userId!).maybeSingle();
  if (profileError) throw profileError;
  if (!ownProfile) { res.status(409).json({error:"Your Relay profile is missing. Apply the account repair SQL in Supabase."}); return; }
  const { data: mine, error: mineError } = await admin.from("conversation_members").select("conversation_id").eq("user_id",req.userId!);
  if (mineError) throw mineError;
  const ids = (mine ?? []).map(m => m.conversation_id);
  if (ids.length) {
    const { data: shared } = await admin.from("conversation_members").select("conversation_id").eq("user_id",target.id).in("conversation_id",ids);
    for (const item of shared ?? []) {
      const { count } = await admin.from("conversation_members").select("*",{count:"exact",head:true}).eq("conversation_id",item.conversation_id);
      if (count === 2) { const {data:existing}=await admin.from("conversations").select("name").eq("id",item.conversation_id).single(); if(existing?.name===null){res.json({id:item.conversation_id});return;} }
    }
  }
  const { data: conversation, error } = await admin.from("conversations").insert({}).select("id").single();
  if (error) throw error;
  const { error: memberError } = await admin.from("conversation_members").insert([{conversation_id:conversation.id,user_id:req.userId!},{conversation_id:conversation.id,user_id:target.id}]);
  if (memberError) {
    await admin.from("conversations").delete().eq("id",conversation.id);
    throw memberError;
  }
  io.to("user:"+target.id).emit("conversations:refresh");
  res.status(201).json(conversation);
}));
app.get("/api/conversations/:id/messages",guard,safe(async(req,res) => {
  const id = z.string().uuid().parse(req.params.id);
  if (!(await member(id,req.userId!))) { res.status(403).json({error:"Forbidden"}); return; }
  const {data,error} = await admin.from("messages").select("id,conversation_id,sender_id,body,created_at,attachment_path,attachment_name,reply_to,reactions:relay_reactions(user_id,emoji)").eq("conversation_id",id).order("created_at",{ascending:false}).limit(100);
  if (error) throw error;
  res.json((data ?? []).reverse());
}));
app.post("/api/conversations/:id/attachments",guard,safe(async(req,res) => {
  const id=z.string().uuid().parse(req.params.id);
  if(!(await member(id,req.userId!))){res.status(403).json({error:"Forbidden"});return;}
  if(!limitRate("upload:"+req.userId,20,60*60*1000)){res.status(429).json({error:"Upload limit reached. Try again later."});return;}
  try{
    const file=await storeFile(req.userId!,"attachments",req.body);
    const {data,error}=await admin.from("messages").insert({conversation_id:id,sender_id:req.userId,body:file.name,attachment_path:file.path,attachment_name:file.name}).select("id,conversation_id,sender_id,body,created_at,attachment_path,attachment_name").single();
    if(error)throw error;
    io.to("conversation:"+id).emit("message:new",data);
    const {data:members}=await admin.from("conversation_members").select("user_id").eq("conversation_id",id);
    for(const m of members??[])io.to("user:"+m.user_id).emit("conversation:activity",{conversationId:id,senderId:req.userId});
    res.status(201).json(data);
  }catch(e){res.status(400).json({error:(e as Error).message});}
}));
app.post("/api/conversations/:id/read",guard,safe(async(req,res) => {
  const id=z.string().uuid().parse(req.params.id);
  if(!(await member(id,req.userId!))){res.status(403).json({error:"Forbidden"});return;}
  const {error}=await admin.from("conversation_members").update({last_read_at:new Date().toISOString()}).eq("conversation_id",id).eq("user_id",req.userId!);
  if(error)throw error;
  io.to("conversation:"+id).emit("conversation:read",{conversationId:id,userId:req.userId,at:new Date().toISOString()});
  res.json({ok:true});
}));
app.patch("/api/messages/:id",guard,safe(async(req,res) => {
  const id = z.string().uuid().parse(req.params.id);
  const parsed = z.object({body:z.string().trim().min(1).max(2000)}).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({error:"Message must contain 1–2000 characters."}); return; }
  const {data:existing,error:lookupError} = await admin.from("messages").select("id,conversation_id,sender_id").eq("id",id).maybeSingle();
  if (lookupError) throw lookupError;
  if (!existing) { res.status(404).json({error:"Message not found"}); return; }
  if (existing.sender_id!==req.userId || !(await member(existing.conversation_id,req.userId!))) {res.status(403).json({error:"You can only edit your own messages"});return;}
  const {data,error}=await admin.from("messages").update({body:parsed.data.body}).eq("id",id).eq("sender_id",req.userId!).select("id,conversation_id,sender_id,body,created_at,attachment_path,attachment_name,reply_to,reactions:relay_reactions(user_id,emoji)").single();
  if(error)throw error;
  io.to("conversation:"+existing.conversation_id).emit("message:updated",data);
  res.json(data);
}));
app.delete("/api/messages/:id",guard,safe(async(req,res) => {
  const id=z.string().uuid().parse(req.params.id);
  const {data:existing,error:lookupError}=await admin.from("messages").select("id,conversation_id,sender_id").eq("id",id).maybeSingle();
  if(lookupError)throw lookupError;
  if(!existing){res.status(404).json({error:"Message not found"});return;}
  if(existing.sender_id!==req.userId || !(await member(existing.conversation_id,req.userId!))){res.status(403).json({error:"You can only delete your own messages"});return;}
  const {error}=await admin.from("messages").delete().eq("id",id).eq("sender_id",req.userId!);
  if(error)throw error;
  io.to("conversation:"+existing.conversation_id).emit("message:deleted",{id,conversationId:existing.conversation_id});
  res.json({ok:true});
}));
io.use(async(socket,next) => {
  try { if (typeof socket.handshake.auth.token !== "string") throw Error(); socket.data.userId = await userFor(socket.handshake.auth.token); next(); }
  catch { next(Error("Unauthorized")); }
});
io.on("connection",socket => {
  const userId = socket.data.userId as string;
  socket.join("user:"+userId);
  io.emit("presence:changed");
  socket.on("disconnect",()=>io.emit("presence:changed"));
  socket.on("conversation:join",async(id:unknown,ack?: (result:{ok:boolean})=>void) => {
    try { if (typeof id !== "string" || !(await member(id,userId))) throw Error(); await socket.join("conversation:"+id); ack?.({ok:true}); }
    catch { ack?.({ok:false}); }
  });
  socket.on("typing",async(payload:unknown) => {
    const parsed = z.object({conversationId:z.string().uuid(),isTyping:z.boolean()}).safeParse(payload);
    if (!parsed.success) return;
    try {
      if (!(await member(parsed.data.conversationId,userId))) return;
      socket.to("conversation:"+parsed.data.conversationId).emit("typing", {conversationId:parsed.data.conversationId,userId,isTyping:parsed.data.isTyping});
    } catch { /* Ignore invalid typing updates. */ }
  });
  socket.on("message:send",async(payload:unknown,ack?: (result:{ok:boolean;error?:string})=>void) => {
    try {
      const {conversationId,body,replyTo} = z.object({conversationId:z.string().uuid(),body:z.string().trim().min(1).max(2000),replyTo:z.string().uuid().optional()}).parse(payload);
      if (!(await member(conversationId,userId))) throw Error();
      if(!limitRate("send:"+userId,30,60*1000)){ack?.({ok:false,error:"You are sending messages too quickly. Please wait a minute."});return;}
      if(replyTo){const {data:parent}=await admin.from("messages").select("id").eq("id",replyTo).eq("conversation_id",conversationId).maybeSingle();if(!parent)throw Error("Invalid reply");}
      const {data,error} = await admin.from("messages").insert({conversation_id:conversationId,sender_id:userId,body,reply_to:replyTo}).select("id,conversation_id,sender_id,body,created_at,reply_to").single();
      if (error) throw error;
      io.to("conversation:"+conversationId).emit("message:new",data);
      const {data:members} = await admin.from("conversation_members").select("user_id").eq("conversation_id",conversationId);
      for (const m of members ?? []) io.to("user:"+m.user_id).emit("conversation:activity",{conversationId,senderId:userId});
      ack?.({ok:true});
    } catch { ack?.({ok:false,error:"Could not send message"}); }
  });
});
app.use((error:unknown,_req:Request,res:Response,_next:NextFunction) => {
  if (error instanceof z.ZodError) { res.status(400).json({error:"Invalid input"}); return; }
  console.error(error);
  const code = (error as {code?:string}|null)?.code;
  if (code === "42703" || code === "PGRST204" || code === "PGRST200" || code === "PGRST205") { res.status(503).json({error:"Database schema is not up to date. Run the Relay files and receipts migration in Supabase, then retry."}); return; }
  res.status(500).json({error:"Internal server error. Check the relay-api Render logs for details."});
});
server.listen(Number(process.env.PORT ?? 4000),"0.0.0.0",()=>console.log("Relay API running"));
