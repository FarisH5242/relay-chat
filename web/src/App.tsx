import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import { io, type Socket } from "socket.io-client";
import { LogOut, MessageCircle, Plus, Send, Zap } from "lucide-react";
const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
const API = import.meta.env.VITE_API_URL;
type Conversation = { id:string; members:{id:string;username:string}[] };
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
    } catch(e) { setError(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-card"><div className="brand"><span className="brand-mark"><Zap size={22}/></span> relay<span className="brand-dot">.</span></div><h1>Conversations, connected.</h1><p className="muted">Your space to stay in touch, in real time.</p><div className="auth-switch"><button className={mode==="login"?"selected":""} onClick={()=>{setMode("login");setError("");}}>Sign in</button><button className={mode==="signup"?"selected":""} onClick={()=>{setMode("signup");setError("");}}>Create account</button></div><form onSubmit={submit}>{mode==="signup"&&<label>Username<input value={username} onChange={e=>setUsername(e.target.value)} placeholder="your_username" required minLength={3} maxLength={24}/></label>}<label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required/></label><label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6}/></label>{error&&<p className="error">{error}</p>}<button className="primary full" disabled={busy}>{busy?"Please wait…":mode==="login"?"Sign in":"Create account"}</button></form><p className="footnote">Built with React, Supabase & Socket.IO</p></section></main>;
}
function Chat({session}:{session:Session}) {
  const [profile,setProfile] = useState<string>("");
  const [conversations,setConversations] = useState<Conversation[]>([]);
  const [active,setActive] = useState<string|null>(null);
  const [messages,setMessages] = useState<Message[]>([]);
  const [draft,setDraft] = useState(""); const [newName,setNewName] = useState("");
  const [creating,setCreating] = useState(false); const [error,setError] = useState("");
  const [connected,setConnected] = useState(false);
  const socketRef = useRef<Socket|null>(null); const activeRef = useRef<string|null>(null);
  const bottom = useRef<HTMLDivElement|null>(null);
  const api = useCallback(async(path:string,init?:RequestInit) => {
    const response = await fetch(API+path,{...init,headers:{"Content-Type":"application/json",Authorization:"Bearer "+session.access_token,...init?.headers}});
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? "Request failed");
    return data;
  },[session.access_token]);
  const refresh = useCallback(async()=>{ try {setConversations(await api("/api/conversations"));} catch(e){setError((e as Error).message);} },[api]);
  useEffect(()=>{ supabase.from("profiles").select("username").eq("id",session.user.id).maybeSingle().then(({data})=>setProfile(data?.username ?? "")); void refresh(); },[session.user.id,refresh]);
  useEffect(()=>{
    const socket = io(API,{auth:{token:session.access_token},transports:["websocket","polling"]});
    socketRef.current = socket;
    socket.on("connect",()=>{setConnected(true);if(activeRef.current)socket.emit("conversation:join",activeRef.current,()=>{void loadMessages(activeRef.current!);});});
    socket.on("disconnect",()=>setConnected(false));
    socket.on("message:new",(message:Message)=>{if(message.conversation_id===activeRef.current)setMessages(prev=>prev.some(m=>m.id===message.id)?prev:[...prev,message]);});
    socket.on("conversations:refresh",()=>void refresh());
    socket.on("conversation:activity",({conversationId}:{conversationId:string})=>{if(conversationId===activeRef.current)void loadMessages(conversationId);});
    async function loadMessages(id:string){try{const rows=await api("/api/conversations/"+id+"/messages");if(activeRef.current===id)setMessages(rows);}catch{}}
    return()=>{socket.disconnect();socketRef.current=null;};
  },[session.access_token,api,refresh]);
  useEffect(()=>{activeRef.current=active;if(!active){setMessages([]);return;}setMessages([]);socketRef.current?.emit("conversation:join",active,()=>{void api("/api/conversations/"+active+"/messages").then(setMessages).catch(e=>setError(e.message));});void api("/api/conversations/"+active+"/messages").then(setMessages).catch(e=>setError(e.message));},[active,api]);
  useEffect(()=>bottom.current?.scrollIntoView({behavior:"smooth"}),[messages]);
  const current = conversations.find(c=>c.id===active);
  function title(c:Conversation){return c.members.filter(m=>m.id!==session.user.id).map(m=>m.username).join(", ")||"Conversation";}
  async function startChat(e:FormEvent) {
    e.preventDefault();setError("");
    try {const result=await api("/api/conversations",{method:"POST",body:JSON.stringify({username:newName.trim().toLowerCase()})});await refresh();setActive(result.id);setCreating(false);setNewName("");}
    catch(e){setError((e as Error).message);}
  }
  function send(e:FormEvent) {
    e.preventDefault();const body=draft.trim();if(!body||!active)return;
    const socket=socketRef.current;if(!socket?.connected){setError("Reconnecting… please try again.");return;}
    socket.emit("message:send",{conversationId:active,body},(result:{ok:boolean;error?:string})=>{if(!result.ok)setError(result.error??"Message failed");});
    setDraft("");
  }
  return <div className="shell"><aside className="sidebar"><div className="side-top"><div className="brand"><span className="brand-mark"><Zap size={20}/></span> relay<span className="brand-dot">.</span></div><button className="icon-button" title="Sign out" onClick={()=>void supabase.auth.signOut()}><LogOut size={18}/></button></div><div className="side-heading"><div><h2>Messages</h2><p className="muted">Your conversations</p></div><button className="icon-button add" title="New chat" onClick={()=>setCreating(v=>!v)}><Plus size={20}/></button></div>{creating&&<form className="new-chat" onSubmit={startChat}><label>Start a conversation<input autoFocus placeholder="Their username" value={newName} onChange={e=>setNewName(e.target.value)} required/></label><button className="primary" type="submit">Start chat</button></form>}<div className="conversation-list">{conversations.length===0?<div className="empty-side">No conversations yet.<br/>Click + to start one.</div>:conversations.map(c=><button key={c.id} className={"conversation "+(active===c.id?"active":"")} onClick={()=>setActive(c.id)}><span className="avatar">{title(c).slice(0,1).toUpperCase()}</span><span className="conversation-text"><strong>{title(c)}</strong><small>Direct message</small></span></button>)}</div><div className="user-panel"><span className="avatar me">{(profile||session.user.email||"U").slice(0,1).toUpperCase()}</span><div><strong>{profile||"Your account"}</strong><small><span className={"status-dot "+(connected?"online":"")}></span>{connected?"Connected":"Connecting…"}</small></div></div></aside><main className="chat-panel">{current?<><header className="chat-header"><span className="avatar">{title(current).slice(0,1).toUpperCase()}</span><div><h3>{title(current)}</h3><small>End-to-end encryption not enabled</small></div></header><div className="messages">{messages.length===0?<div className="welcome"><MessageCircle size={34}/><h2>Say hello 👋</h2><p>This is the beginning of your conversation.</p></div>:messages.map(m=><div key={m.id} className={"message-row "+(m.sender_id===session.user.id?"mine":"")}><div className="bubble">{m.body}<time>{new Date(m.created_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time></div></div>)}<div ref={bottom}/></div><form className="composer" onSubmit={send}><input placeholder={"Message "+title(current)+"…"} value={draft} onChange={e=>setDraft(e.target.value)} maxLength={2000}/><button className="primary send" disabled={!draft.trim()||!connected} aria-label="Send message"><Send size={19}/></button></form></>:<div className="welcome"><span className="welcome-icon"><MessageCircle size={40}/></span><h1>Your conversations start here</h1><p>Select a chat or create a new conversation to get started.</p><button className="primary" onClick={()=>setCreating(true)}><Plus size={17}/> New conversation</button></div>}{error&&<div className="toast" role="alert">{error}<button onClick={()=>setError("")}>×</button></div>}</main></div>;
}
export default function App() {
  const [session,setSession] = useState<Session|null>(null); const [loading,setLoading] = useState(true);
  useEffect(()=>{supabase.auth.getSession().then(({data})=>{setSession(data.session);setLoading(false);});const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,s)=>setSession(s));return()=>subscription.unsubscribe();},[]);
  if(loading)return <div className="loading">Loading Relay…</div>;
  return session?<Chat key={session.access_token} session={session}/>:<Auth onAuth={setSession}/>;
}
