import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type FormEvent, type ReactNode } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import { io, type Socket } from "socket.io-client";
import { LogOut, MessageCircle, Plus, Send, Layers3, Search, Settings2, X, Check, WifiOff, Pencil, Trash2 } from "lucide-react";
// Accept a Supabase project URL even if a dashboard/API path was pasted by mistake.
// The auth client adds /auth/v1 itself; including it twice breaks login and signup.
function resolveSupabaseUrl(value: string | undefined): string {
  const raw = value?.trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new Error("VITE_SUPABASE_URL is missing in the frontend build.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("VITE_SUPABASE_URL must be a valid HTTPS project URL."); }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("VITE_SUPABASE_URL must use HTTPS.");
  }
  // The project base URL must not include /auth/v1, /rest/v1 or other API routes.
  return url.origin;
}
const supabaseUrl = resolveSupabaseUrl(import.meta.env.VITE_SUPABASE_URL);
const supabase = createClient(supabaseUrl, import.meta.env.VITE_SUPABASE_ANON_KEY);
const API = (import.meta.env.VITE_API_URL ?? "").trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
function apiEndpoint(path: string): string {
  if (!API) throw Error("Backend URL is missing. Set VITE_API_URL in Render relay-web to your relay-api service URL, then redeploy.");
  let parsed: URL;
  try { parsed = new URL(API); } catch { throw Error("VITE_API_URL is invalid. Use the full HTTPS URL of relay-api."); }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") throw Error("VITE_API_URL must use HTTPS.");
  return API + path;
}
function explainAuthError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Authentication failed";
  if (/invalid path specified in request url/i.test(message)) {
    return "Supabase rejected the authentication endpoint. Configured project host: " +
      new URL(supabaseUrl).hostname +
      ". Check that this host matches Project Settings → Data API → Project URL in Supabase, then rebuild the Render frontend.";
  }
  return message;
}
type Conversation = { id:string; members:{id:string;username:string}[] };
class ChatErrorBoundary extends Component<{children:ReactNode},{error:string|null;stack:string|null}> {
  state:{error:string|null;stack:string|null} = {error:null,stack:null};
  static getDerivedStateFromError(error:Error) { return {error:error.message}; }
  componentDidCatch(error:Error, info:ErrorInfo) { console.error("Relay chat render failed",error,info); this.setState({stack:error.stack ?? info.componentStack ?? null}); }
  render() {
    if (this.state.error) return <main className="auth-page"><section className="auth-card"><h1>Chat couldn't open</h1><p className="muted">{this.state.error}</p><button className="primary full" onClick={()=>this.setState({error:null})}>Try again</button><button className="primary full" onClick={()=>window.location.reload()}>Reload Relay</button></section></main>;
    return this.props.children;
  }
}
type Message = {id:string;conversation_id:string;sender_id:string;body:string;created_at:string};
function Auth({onAuth}:{onAuth:(session:Session)=>void}) {
  const [mode,setMode] = useState<"login"|"signup">("login");
  const [email,setEmail] = useState(""); const [password,setPassword] = useState(""); const [username,setUsername] = useState("");
  const [error,setError] = useState(""); const [busy,setBusy] = useState(false);
  async function submit(e:FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      if (mode === "signup") {
        const name = username.trim().toLowerCase();
        if (!/^[a-z0-9_]{3,24}$/.test(name)) throw Error("Username must be 3–24 lowercase letters, numbers or underscores.");
        const {data,error} = await supabase.auth.signUp({email,password,options:{data:{username:name}}});
        if (error) throw error;
        if (!data.session) { setError("Account created. Confirm your email, then sign in."); setMode("login"); return; }
        onAuth(data.session);
      } else {
        const {data,error} = await supabase.auth.signInWithPassword({email,password});
        if (error) throw error;
        onAuth(data.session!);
      }
    } catch(e) { setError(explainAuthError(e)); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-card"><div className="brand"><span className="brand-mark"><Layers3 size={21}/></span> Relay</div><h1>Communication, simplified.</h1><p className="muted">A focused workspace for your conversations.</p><div className="auth-switch"><button className={mode==="login"?"selected":""} onClick={()=>{setMode("login");setError("");}}>Sign in</button><button className={mode==="signup"?"selected":""} onClick={()=>{setMode("signup");setError("");}}>Create account</button></div><form onSubmit={submit}>{mode==="signup"&&<label>Username<input value={username} onChange={e=>setUsername(e.target.value)} placeholder="your_username" required minLength={3} maxLength={24}/></label>}<label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6}/></label>{error&&<p className="error">{error}</p>}<button className="primary full" disabled={busy}>{busy?"Please wait…":mode==="login"?"Sign in":"Create account"}</button></form><p className="footnote">SECURE ACCOUNT ACCESS</p></section></main>;
}
function Chat({session}:{session:Session}) {
  const [profile,setProfile] = useState<string>("");
  const [conversations,setConversations] = useState<Conversation[]>([]);
  const [active,setActive] = useState<string|null>(null);
  const [messages,setMessages] = useState<Message[]>([]);
  const [draft,setDraft] = useState(""); const [newName,setNewName] = useState("");
  const [creating,setCreating] = useState(false); const [error,setError] = useState("");
  const [search,setSearch] = useState("");
  const [messageSearch,setMessageSearch] = useState("");
  const [editingId,setEditingId] = useState<string|null>(null);
  const [editBody,setEditBody] = useState("");
  const [showMessageSearch,setShowMessageSearch] = useState(false);
  const [showProfile,setShowProfile] = useState(false);
  const [profileName,setProfileName] = useState("");
  const [savingProfile,setSavingProfile] = useState(false);
  const [typingUsers,setTypingUsers] = useState<string[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout>|null>(null);
  const [connected,setConnected] = useState(false);
  const socketRef = useRef<Socket|null>(null); const activeRef = useRef<string|null>(null);
  const bottom = useRef<HTMLDivElement|null>(null);
  const api = useCallback(async(path:string,init?:RequestInit) => {
    const endpoint = apiEndpoint(path);
    const request = async(token:string) => {
      try {
        return await fetch(endpoint,{...init,headers:{"Content-Type":"application/json",Authorization:"Bearer "+token,...init?.headers}});
      } catch {
        throw Error("Cannot reach Relay API at " + new URL(endpoint).origin + ". Check VITE_API_URL and relay-api service status.");
      }
    };
    const {data:sessionData,error:sessionError} = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) throw Error("Your session has expired. Please sign out and sign in again.");
    let response = await request(sessionData.session.access_token);
    if (response.status === 401) {
      const {data:refreshed,error:refreshError} = await supabase.auth.refreshSession();
      if (refreshError || !refreshed.session) throw Error("Your session could not be refreshed. Please sign out and sign in again.");
      response = await request(refreshed.session.access_token);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) throw Error("Relay API rejected your Supabase session. Check that relay-api SUPABASE_URL and SUPABASE_ANON_KEY belong to the same Supabase project as relay-web.");
      throw Error(data?.error ?? "Relay API returned HTTP " + response.status);
    }
    return data;
  },[]);
  const refresh = useCallback(async()=>{ try {const rows = await api("/api/conversations");setConversations(Array.isArray(rows)?rows:[]);} catch(e){setError((e as Error).message);} },[api]);
  useEffect(()=>{ void api("/api/me").then(data=>{setProfile(data.username);setProfileName(data.username);}).catch(e=>setError(e.message));void refresh(); },[api,refresh]);
  async function saveProfile(e:FormEvent) {
    e.preventDefault();setSavingProfile(true);setError("");
    try {const data=await api("/api/me",{method:"PATCH",body:JSON.stringify({username:profileName.trim()})});setProfile(data.username);setProfileName(data.username);setShowProfile(false);await refresh();}
    catch(e){setError((e as Error).message);}finally{setSavingProfile(false);}
  }
  function updateDraft(value:string) {
    setDraft(value);
    if (!active || !socketRef.current?.connected) return;
    socketRef.current.emit("typing",{conversationId:active,isTyping:value.trim().length>0});
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current=setTimeout(()=>socketRef.current?.emit("typing",{conversationId:active,isTyping:false}),1400);
  }
  useEffect(()=>{
    const socket = io(API || undefined,{auth:{token:session.access_token},transports:["websocket","polling"]});
    socketRef.current = socket;
    socket.on("connect",()=>{setConnected(true);if(activeRef.current)socket.emit("conversation:join",activeRef.current,()=>{void loadMessages(activeRef.current!);});});
    socket.on("disconnect",()=>{setConnected(false);setTypingUsers([]);});
    socket.on("connect_error",()=>setConnected(false));
    socket.on("message:new",(message:Message)=>{if(message.conversation_id===activeRef.current)setMessages(prev=>prev.some(m=>m.id===message.id)?prev:[...prev,message]);});
    socket.on("message:updated",(message:Message)=>{if(message.conversation_id===activeRef.current)setMessages(prev=>prev.map(m=>m.id===message.id?message:m));});
    socket.on("message:deleted",({id,conversationId}:{id:string;conversationId:string})=>{if(conversationId===activeRef.current)setMessages(prev=>prev.filter(m=>m.id!==id));});
    socket.on("conversations:refresh",()=>void refresh());
    socket.on("profiles:updated",()=>void refresh());
    socket.on("typing",({conversationId,userId,isTyping}:{conversationId:string;userId:string;isTyping:boolean})=>{
      if(conversationId!==activeRef.current || userId===session.user.id)return;
      setTypingUsers(previous=>isTyping?Array.from(new Set([...previous,userId])):previous.filter(id=>id!==userId));
    });
    socket.on("conversation:activity",({conversationId}:{conversationId:string})=>{if(conversationId===activeRef.current)void loadMessages(conversationId);});
    async function loadMessages(id:string){try{const rows=await api("/api/conversations/"+id+"/messages");if(activeRef.current===id)setMessages(Array.isArray(rows)?rows:[]);}catch{}}
    return()=>{if(typingTimer.current)clearTimeout(typingTimer.current);socket.disconnect();socketRef.current=null;};
  },[session.access_token,api,refresh]);
  useEffect(()=>{activeRef.current=active;setTypingUsers([]);setEditingId(null);setMessageSearch("");setShowMessageSearch(false);if(!active){setMessages([]);return;}setMessages([]);socketRef.current?.emit("conversation:join",active,()=>{void api("/api/conversations/"+active+"/messages").then(rows=>setMessages(Array.isArray(rows)?rows:[])).catch(e=>setError(e.message));});void api("/api/conversations/"+active+"/messages").then(rows=>setMessages(Array.isArray(rows)?rows:[])).catch(e=>setError(e.message));},[active,api]);
  useEffect(()=>{const element=bottom.current;if(element && typeof element.scrollIntoView === "function") element.scrollIntoView({behavior:"smooth"});},[messages]);
  const current = conversations.find(c=>c.id===active);
  const visibleMessages = messages.filter(m=>!messageSearch.trim()||m.body.toLowerCase().includes(messageSearch.trim().toLowerCase()));
  function title(c:Conversation){return (Array.isArray(c.members)?c.members:[]).filter(m=>m && m.id!==session.user.id).map(m=>m.username || "Unknown").join(", ")||"Conversation";}
  async function startChat(e:FormEvent) {
    e.preventDefault();setError("");
    try {const result=await api("/api/conversations",{method:"POST",body:JSON.stringify({username:newName.trim().toLowerCase()})});await refresh();setActive(result.id);setCreating(false);setNewName("");}
    catch(e){setError((e as Error).message);}
  }
  async function editMessage(e:FormEvent) {
    e.preventDefault();if(!editingId)return;
    try{const updated=await api("/api/messages/"+editingId,{method:"PATCH",body:JSON.stringify({body:editBody})});setMessages(prev=>prev.map(m=>m.id===updated.id?updated:m));setEditingId(null);setEditBody("");}
    catch(e){setError((e as Error).message);}
  }
  async function deleteMessage(id:string) {
    if(!window.confirm("Delete this message?"))return;
    try{await api("/api/messages/"+id,{method:"DELETE"});setMessages(prev=>prev.filter(m=>m.id!==id));}
    catch(e){setError((e as Error).message);}
  }
  function send(e:FormEvent) {
    e.preventDefault();const body=draft.trim();if(!body||!active)return;
    const socket=socketRef.current;if(!socket?.connected){setError("Reconnecting… please try again.");return;}
    socket.emit("message:send",{conversationId:active,body},(result:{ok:boolean;error?:string})=>{if(!result.ok){setError(result.error??"Message failed");setDraft(previous=>previous||body);}});
    setDraft("");socket.emit("typing",{conversationId:active,isTyping:false});
  }
  return <div className="shell"><aside className="sidebar"><div className="side-top"><div className="brand"><span className="brand-mark"><Layers3 size={19}/></span> Relay</div><div className="top-actions"><button className="icon-button" title="Profile settings" aria-label="Profile settings" onClick={()=>setShowProfile(true)}><Settings2 size={18}/></button><button className="icon-button" title="Sign out" onClick={()=>void supabase.auth.signOut()}><LogOut size={18}/></button></div></div><div className="side-heading"><div><h2>Inbox</h2><p className="muted">Direct conversations</p></div><button className="icon-button add" title="New chat" onClick={()=>setCreating(v=>!v)}><Plus size={20}/></button></div>{creating&&<form className="new-chat" onSubmit={startChat}><label>Start a conversation<input autoFocus placeholder="Their username" value={newName} onChange={e=>setNewName(e.target.value)} required/></label><button className="primary" type="submit">Start chat</button></form>}<div className="sidebar-search"><Search size={16}/><input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={e=>setSearch(e.target.value)}/></div><div className="sidebar-section-label">CONVERSATIONS</div><div className="conversation-list">{conversations.length===0?<div className="empty-side">No conversations yet.<br/>Select + to begin.</div>:conversations.filter(c=>title(c).toLowerCase().includes(search.trim().toLowerCase())).map(c=><button key={c.id} className={"conversation "+(active===c.id?"active":"")} onClick={()=>setActive(c.id)}><span className="avatar">{title(c).slice(0,1).toUpperCase()}</span><span className="conversation-text"><strong>{title(c)}</strong><small>Direct conversation</small></span></button>)}</div><div className="user-panel" onClick={()=>setShowProfile(true)} role="button" tabIndex={0} onKeyDown={e=>{if(e.key==="Enter")setShowProfile(true);}}><span className="avatar me">{(profile||session.user.email||"U").slice(0,1).toUpperCase()}</span><div><strong>{profile||"Your account"}</strong><small><span className={"status-dot "+(connected?"online":"")}></span>{connected?"Connected":"Connecting…"}</small></div></div></aside><main className="chat-panel">{current?<><header className="chat-header"><span className="avatar">{title(current).slice(0,1).toUpperCase()}</span><div><h3>{title(current)}</h3><small>Direct conversation · Not end-to-end encrypted</small></div><div className="header-actions"><button className="icon-button" aria-label="Search messages" title="Search messages" onClick={()=>setShowMessageSearch(v=>!v)}><Search size={19}/></button></div></header>{showMessageSearch&&<div className="message-search"><Search size={16}/><input autoFocus placeholder="Find in conversation…" value={messageSearch} onChange={e=>setMessageSearch(e.target.value)}/><button className="icon-button" title="Close search" onClick={()=>{setShowMessageSearch(false);setMessageSearch("");}}><X size={16}/></button></div>}<div className="messages">{visibleMessages.length===0?<div className="welcome"><MessageCircle size={34}/><h2>Start the conversation</h2><p>Your messages will appear here.</p></div>:visibleMessages.map(m=><div key={m.id} className={"message-row "+(m.sender_id===session.user.id?"mine":"")}><div className="bubble">{editingId===m.id?<form className="edit-message" onSubmit={editMessage}><input autoFocus value={editBody} onChange={e=>setEditBody(e.target.value)} maxLength={2000} required/><div><button type="button" onClick={()=>setEditingId(null)}>Cancel</button><button type="submit">Save</button></div></form>:m.body}<time>{new Date(m.created_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time>{m.sender_id===session.user.id&&<div className="message-actions"><button aria-label="Edit message" title="Edit message" onClick={()=>{setEditingId(m.id);setEditBody(m.body);}}><Pencil size={13}/></button><button aria-label="Delete message" title="Delete message" onClick={()=>void deleteMessage(m.id)}><Trash2 size={13}/></button></div>}</div></div>)}<div ref={bottom}/></div>{typingUsers.length>0&&<div className="typing-indicator"><span className="typing-dots"><i/><i/><i/></span> Typing…</div>}<form className="composer" onSubmit={send}><input placeholder={"Message "+title(current)+"…"} value={draft} onChange={e=>updateDraft(e.target.value)} maxLength={2000}/><button className="primary send" disabled={!draft.trim()||!connected} aria-label="Send message"><Send size={19}/></button></form></>:<div className="welcome"><span className="welcome-icon"><MessageCircle size={40}/></span><h1>Your workspace is ready</h1><p>Choose a conversation from the sidebar or start a new one.</p><button className="primary" onClick={()=>setCreating(true)}><Plus size={17}/> New conversation</button></div>}{!connected&&<div className="connection-banner"><WifiOff size={15}/> Reconnecting to real-time messaging…</div>}{error&&<div className="toast" role="alert">{error}<button onClick={()=>setError("")}>×</button></div>}</main>{showProfile&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setShowProfile(false);}}><section className="profile-modal" role="dialog" aria-modal="true" aria-label="Account settings"><div className="modal-heading"><div><span className="eyebrow">ACCOUNT</span><h2>Profile settings</h2></div><button className="icon-button" aria-label="Close" onClick={()=>setShowProfile(false)}><X size={19}/></button></div><div className="profile-summary"><span className="avatar me">{(profile||"U").slice(0,1).toUpperCase()}</span><div><strong>{profile||"Your account"}</strong><small>{session.user.email}</small></div></div><form onSubmit={saveProfile}><label>Username<input value={profileName} onChange={e=>setProfileName(e.target.value)} minLength={3} maxLength={24} pattern="[a-zA-Z0-9_]{3,24}" required/></label><p className="form-hint">3–24 letters, numbers or underscores. Other people use this to find you.</p><button className="primary full" disabled={savingProfile}><Check size={16}/>{savingProfile?"Saving…":"Save changes"}</button></form></section></div>}</div>;
}
export default function App() {
  const [session,setSession] = useState<Session|null>(null); const [loading,setLoading] = useState(true);
  useEffect(()=>{supabase.auth.getSession().then(({data})=>{setSession(data.session);setLoading(false);});const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,s)=>setSession(s));return()=>subscription.unsubscribe();},[]);
  if(loading)return <div className="loading">Loading Relay…</div>;
  return session?<ChatErrorBoundary><Chat key={session.user.id} session={session}/></ChatErrorBoundary>:<Auth onAuth={setSession}/>;
}
