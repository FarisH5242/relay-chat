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
app.use(express.json({ limit: "16kb" }));
const server = createServer(app);
const io = new Server(server, { cors: corsOptions });
type AuthReq = Request & { userId?: string };
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
app.get("/api/me",guard,safe(async(req,res) => {
  const {data,error} = await admin.from("profiles").select("id,username,created_at").eq("id",req.userId!).maybeSingle();
  if (error) throw error;
  if (!data) { res.status(404).json({error:"Profile missing. Run the profile backfill migration in Supabase."}); return; }
  res.json(data);
}));
app.patch("/api/me",guard,safe(async(req,res) => {
  const parsed = z.object({username:z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/)}).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({error:"Username must be 3–24 letters, numbers or underscores."}); return; }
  const {data,error} = await admin.from("profiles").update({username:parsed.data.username}).eq("id",req.userId!).select("id,username").single();
  if (error) {
    if (error.code === "23505") { res.status(409).json({error:"That username is already taken."}); return; }
    throw error;
  }
  io.emit("profiles:updated");
  res.json(data);
}));
app.get("/api/conversations",guard,safe(async(req,res) => {
  const { data: mine, error } = await admin.from("conversation_members").select("conversation_id").eq("user_id",req.userId!);
  if (error) throw error;
  const ids = (mine ?? []).map(m => m.conversation_id);
  if (!ids.length) { res.json([]); return; }
  const { data: all, error: e } = await admin.from("conversation_members").select("conversation_id,user_id,profiles(username)").in("conversation_id",ids);
  if (e) throw e;
  res.json(ids.map(id => ({ id, members:(all ?? []).filter(m => m.conversation_id === id).map(m => ({ id:m.user_id, username:(m.profiles as any)?.username ?? "Unknown" })) })));
}));
app.post("/api/conversations",guard,safe(async(req,res) => {
  const parsed = z.object({ username:z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({error:"Enter the Relay username (not an email): 3–24 lowercase letters, numbers or underscores. Check the username in Supabase public.profiles."});
    return;
  }
  const { username } = parsed.data;
  const { data: target, error: e } = await admin.from("profiles").select("id").eq("username",username).maybeSingle();
  if (e) throw e;
  if (!target) { res.status(404).json({error:"Username not found"}); return; }
  if (target.id === req.userId) { res.status(400).json({error:"Cannot chat with yourself"}); return; }
  const { data: mine } = await admin.from("conversation_members").select("conversation_id").eq("user_id",req.userId!);
  const ids = (mine ?? []).map(m => m.conversation_id);
  if (ids.length) {
    const { data: shared } = await admin.from("conversation_members").select("conversation_id").eq("user_id",target.id).in("conversation_id",ids);
    for (const item of shared ?? []) {
      const { count } = await admin.from("conversation_members").select("*",{count:"exact",head:true}).eq("conversation_id",item.conversation_id);
      if (count === 2) { res.json({id:item.conversation_id}); return; }
    }
  }
  const { data: conversation, error } = await admin.from("conversations").insert({}).select("id").single();
  if (error) throw error;
  const { error: memberError } = await admin.from("conversation_members").insert([{conversation_id:conversation.id,user_id:req.userId!},{conversation_id:conversation.id,user_id:target.id}]);
  if (memberError) throw memberError;
  io.to("user:"+target.id).emit("conversations:refresh");
  res.status(201).json(conversation);
}));
app.get("/api/conversations/:id/messages",guard,safe(async(req,res) => {
  const id = z.string().uuid().parse(req.params.id);
  if (!(await member(id,req.userId!))) { res.status(403).json({error:"Forbidden"}); return; }
  const {data,error} = await admin.from("messages").select("id,conversation_id,sender_id,body,created_at").eq("conversation_id",id).order("created_at",{ascending:false}).limit(100);
  if (error) throw error;
  res.json((data ?? []).reverse());
}));
io.use(async(socket,next) => {
  try { if (typeof socket.handshake.auth.token !== "string") throw Error(); socket.data.userId = await userFor(socket.handshake.auth.token); next(); }
  catch { next(Error("Unauthorized")); }
});
io.on("connection",socket => {
  const userId = socket.data.userId as string;
  socket.join("user:"+userId);
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
      const {conversationId,body} = z.object({conversationId:z.string().uuid(),body:z.string().trim().min(1).max(2000)}).parse(payload);
      if (!(await member(conversationId,userId))) throw Error();
      const {data,error} = await admin.from("messages").insert({conversation_id:conversationId,sender_id:userId,body}).select("id,conversation_id,sender_id,body,created_at").single();
      if (error) throw error;
      io.to("conversation:"+conversationId).emit("message:new",data);
      const {data:members} = await admin.from("conversation_members").select("user_id").eq("conversation_id",conversationId);
      for (const m of members ?? []) io.to("user:"+m.user_id).emit("conversation:activity",{conversationId});
      ack?.({ok:true});
    } catch { ack?.({ok:false,error:"Could not send message"}); }
  });
});
app.use((error:unknown,_req:Request,res:Response,_next:NextFunction) => {
  if (error instanceof z.ZodError) { res.status(400).json({error:"Invalid input"}); return; }
  console.error(error); res.status(500).json({error:"Internal server error"});
});
server.listen(Number(process.env.PORT ?? 4000),"0.0.0.0",()=>console.log("Relay API running"));
