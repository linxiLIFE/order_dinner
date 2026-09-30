import { apiUrl } from "./platform.js";
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, getToken, money, formatTime, prepareIdempotentRequest, clearIdempotentRequest } from './api.js';

type Chat = {id:string;title:string;date_from:string;date_to:string;updated_at:string;running_until?:string;context?:{asOf:string;current:{summary:Record<string,number>};previous:{range:{from:string;to:string};summary:Record<string,number>};year:{summary:Record<string,number>}}};
type Message = {id:string;role:'user'|'assistant';content:string;images:string[];status:string;created_at:string};
type Memory = {key:string;content:unknown;updated_at:string};
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
const iso = (d:Date)=>d.toISOString().slice(0,10);
const starter = '请分析这段时间的营业成果，与上期和去年同期对比，找到影响营业额的关键因素，并给出可执行的增收计划。';
export function BusinessAiPage({initialRange,onBack}:{initialRange:{from:string;to:string};onBack:()=>void}) {
  const [from,setFrom]=useState(initialRange.from),[to,setTo]=useState(initialRange.to);
  const [chats,setChats]=useState<Chat[]>([]),[hasMore,setHasMore]=useState(false),[active,setActive]=useState<Chat|null>(null),[messages,setMessages]=useState<Message[]>([]);
  const [text,setText]=useState(''),[images,setImages]=useState<string[]>([]),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState(''),[configured,setConfigured]=useState(true);
  const [memoryOpen,setMemoryOpen]=useState(false),[memories,setMemories]=useState<Memory[]>([]),[profile,setProfile]=useState(''),[saving,setSaving]=useState(false);
  const controller=useRef<AbortController|null>(null), activeId=useRef('');
  const [scrollTarget,setScrollTarget]=useState(''),[trash,setTrash]=useState(false),[removing,setRemoving]=useState('');
  async function list(more=false,showTrash=trash) {
    const result=await api<{chats:Chat[];hasMore:boolean;configured:boolean}>(`/api/business-ai/chats?offset=${more?chats.length:0}&trash=${showTrash}`);
    setChats(old=>more?[...old,...result.chats]:result.chats);setHasMore(result.hasMore);setConfigured(result.configured);
  }
  async function loadMemory(){const data=await api<{memories:Memory[]}>('/api/business-ai/memory');setMemories(data.memories);setProfile(String(data.memories.find(m=>m.key==='profile')?.content || ''));}
  useEffect(()=>{void list().catch(e=>setError(e.message));return()=>controller.current?.abort();},[]);
  useEffect(()=>{if(!scrollTarget)return;const frame=requestAnimationFrame(()=>document.getElementById(`ai-message-${scrollTarget}`)?.scrollIntoView({block:'start'}));return()=>cancelAnimationFrame(frame);},[scrollTarget]);
  async function open(id:string){
    if(busy)return;setLoading(true);setError('');activeId.current=id;
    try{const result=await api<{chat:Chat;messages:Message[]}>(`/api/business-ai/chats/${id}`);if(activeId.current!==id)return;setActive(result.chat);setMessages(result.messages);setFrom(result.chat.date_from);setTo(result.chat.date_to);setText('');setImages([]);window.scrollTo({top:0});}catch(e){setError((e as Error).message);}finally{setLoading(false);}
  }
  useEffect(()=>{if(busy||!active?.running_until)return;const timer=window.setInterval(()=>{void api<{chat:Chat;messages:Message[]}>(`/api/business-ai/chats/${active.id}`).then(result=>{setActive(result.chat);setMessages(result.messages);}).catch(()=>{});},3000);return()=>window.clearInterval(timer);},[busy,active?.id,active?.running_until]);
  function preset(days:number){const d=new Date(today());d.setUTCDate(d.getUTCDate()-days+1);setFrom(iso(d));setTo(today());}
  async function send(value=text, attached=images, newChat=false){
    if(busy||loading||(!value.trim()&&!attached.length))return;
    setBusy(true);setError('');setStatus('准备数据');
    const abort=new AbortController();controller.current=abort;
    let chatId=active?.id || '';
    let receivedDone=false;
    try{
      if(newChat||!chatId){const created=await api<{id:string}>('/api/business-ai/chats',{method:'POST',body:JSON.stringify({from,to}),signal:abort.signal});chatId=created.id;const detail=await api<{chat:Chat;messages:Message[]}>(`/api/business-ai/chats/${chatId}`);setActive(detail.chat);setMessages([]);activeId.current=chatId;}
      const pending=prepareIdempotentRequest(`business-ai:${chatId}`,{text:value,images:attached});
      const response=await fetch(apiUrl(`/api/business-ai/chats/${chatId}/messages`),{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${getToken()}`},body:JSON.stringify({requestId:pending.idempotencyKey,...pending.payload}),signal:abort.signal});
      if(!response.ok){const body=await response.json();if(response.status>=400&&response.status<500&&response.status!==401&&response.status!==429)clearIdempotentRequest(`business-ai:${chatId}`);if(response.status===401)window.dispatchEvent(new Event('点单台登录失效'));throw new Error(body.error||'分析请求失败');}
      if(!response.body)throw new Error('浏览器未提供流式响应');
      setText('');setImages([]);setStatus('正在思考');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',assistantId='',pendingText='';
      let flushTimer:ReturnType<typeof setTimeout>|undefined;
      const flush=()=>{clearTimeout(flushTimer);flushTimer=undefined;if(pendingText){const delta=pendingText;pendingText='';setMessages(old=>old.map(m=>m.id===assistantId?{...m,content:m.content+delta}:m));}};
      const consume=(block:string)=>{
        const event=block.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim();
        const payload=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!payload)return;
        const data=JSON.parse(payload);
        if(event==='start'){clearIdempotentRequest(`business-ai:${chatId}`);assistantId=data.assistant.id;setMessages(old=>[...old,data.user,data.assistant]);setScrollTarget(data.user.id);}
        if(event==='delta'){setStatus('正在生成');pendingText+=data.text;if(!flushTimer)flushTimer=setTimeout(flush,100);}
        if(event==='thinking')setStatus('正在思考');
        if(event==='error')throw new Error(data.error);
        if(event==='done'){flush();receivedDone=true;setMessages(old=>old.map(m=>m.id===assistantId?{...m,status:data.finish==='length'?'length':'complete'}:m));}
      };
      try { while(true){const next=await reader.read();buffer+=decoder.decode(next.value,{stream:!next.done});const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop()||'';blocks.forEach(consume);if(next.done){if(buffer.trim())consume(buffer);break;}} } finally {flush();}
      if(!receivedDone)throw new Error('连接中断，已生成内容保留在历史中');
    }catch(e){if((e as Error).name==='AbortError')setStatus('已停止');else setError((e as Error).message);}
    finally{controller.current?.abort();controller.current=null;setBusy(false);setStatus('');if(chatId){try{const detail=await api<{chat:Chat;messages:Message[]}>(`/api/business-ai/chats/${chatId}`);setActive(detail.chat);setMessages(detail.messages);}catch{ /* Existing stream content stays visible. */ }}void list().catch(()=>{});}
  }
  async function upload(files:FileList|null){if(!files)return;setError('');try{
    const pending=Array.from(files);if(images.length+pending.length>3)throw new Error('每条消息最多3张图片');
    const data=await Promise.all(pending.map(file=>new Promise<string>((resolve,reject)=>{
      if(!['image/jpeg','image/png','image/webp'].includes(file.type))return reject(new Error('支持 JPG、PNG、WebP 图片'));
      if(file.size>5*1024*1024)return reject(new Error('每张图片请控制在5MB以内'));
      const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('图片读取失败'));reader.readAsDataURL(file);
    })));setImages(old=>[...old,...data]);
  }catch(e){setError((e as Error).message);}}
  function exportReport(){const report=messages.map(m=>`## ${m.role==='user'?'我':'经营顾问'}\n\n${m.content}`).join('\n\n---\n\n');const blob=new Blob([`# ${active?.title || '营业分析'}\n\n${report}`],{type:'text/markdown;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`营业分析-${active?.date_from || from}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function removeChat(id:string){
    setRemoving(id);setError('');
    try{await api(`/api/business-ai/chats/${id}`,{method:'DELETE'});if(active?.id===id){setActive(null);setMessages([]);setText('');setImages([]);}await list();}
    catch(e){setError((e as Error).message);}finally{setRemoving('');}
  }
  async function restoreChat(id:string){
    setRemoving(id);try{await api(`/api/business-ai/chats/${id}/restore`,{method:'POST'});await list();}catch(e){setError((e as Error).message);}finally{setRemoving('');}
  }
  const summary=active?.context?.current.summary,previous=active?.context?.previous.summary;
  const change=summary && previous && previous.revenueFen>0?((summary.revenueFen-previous.revenueFen)/previous.revenueFen*100):null;
  const running=busy || loading || Boolean(active?.running_until && new Date(active.running_until).getTime()>Date.now());
  return <section className="ai-page">
    <div className="ai-heading"><button className="secondary" onClick={onBack}>退出</button></div>
    <div className="ai-layout">
      <aside className="ai-sidebar">
        <button className="primary" disabled={busy||loading} onClick={()=>{activeId.current='';setActive(null);setMessages([]);setText('');setImages([]);setError('');setTrash(false);void list(false,false).catch(e=>setError(e.message));window.scrollTo({top:0});}}>＋ 新建分析</button>
        <div className="ai-history-heading"><span>{trash?'回收站':'历史对话'}</span><button className="text-button" disabled={busy||loading} onClick={()=>{setTrash(!trash);void list(false,!trash).catch(e=>setError(e.message));}}>{trash?'返回':'回收站'}</button></div>
        <div className="ai-history">
          {chats.map(c=><div key={c.id} className={`ai-history-row${active?.id===c.id?' selected':''}`}>
            <button className="ai-history-open" disabled={busy||loading||trash} onClick={()=>void open(c.id)}><strong>{c.title}</strong><small>{formatTime(c.updated_at)}</small></button>
            {trash?<button className="text-button ai-history-action" disabled={Boolean(removing)} onClick={()=>void restoreChat(c.id)}>恢复</button>:<button className="text-button ai-history-action" aria-label={`删除 ${c.title}`} disabled={busy||loading||Boolean(removing)||Boolean(c.running_until&&new Date(c.running_until).getTime()>Date.now())} onClick={()=>void removeChat(c.id)}>删除</button>}
          </div>)}
          {hasMore&&<button className="text-button" onClick={()=>void list(true).catch(e=>setError(e.message))}>更多</button>}
        </div>
        <div className="ai-sidebar-actions"><button className="text-button" onClick={()=>{setMemoryOpen(true);void loadMemory().catch(e=>setError(e.message));}}>经营背景</button><button className="text-button" disabled={!messages.length} onClick={exportReport}>导出报告</button></div>
      </aside>
      <div className="ai-workspace">
        <div className="ai-range">
          <label>开始日期<input type="date" max={today()} value={from} disabled={running} onChange={e=>setFrom(e.target.value)}/></label><span>至</span>
          <label>结束日期<input type="date" max={today()} value={to} disabled={running} onChange={e=>setTo(e.target.value)}/></label>
          <div className="ai-presets">{[7,30,90].map(n=><button className="text-button" key={n} disabled={running} onClick={()=>preset(n)}>近{n}天</button>)}</div>
          <button className="primary" disabled={running||!configured||!from||!to||from>to} onClick={()=>void send(starter+(text.trim()?`\n\n补充经营情况：${text.trim()}`:''),images,true)}>{busy?'分析中…':'开始分析'}</button>
        </div>
        {!configured&&<div className="message error">分析服务尚未配置</div>}
        {summary&&<div className="ai-metrics"><div><small>营业额</small><strong>{money(summary.revenueFen)}</strong>{change!==null&&<span className={change>=0?'positive':''}>上期 {change>=0?'+':''}{change.toFixed(1)}%</span>}</div><div><small>订单</small><strong>{summary.orderCount}<em>单</em></strong></div><div><small>客单价</small><strong>{money(summary.averageOrderFen)}</strong></div><div><small>毛利率</small><strong>{summary.grossMarginPercent}<em>%</em></strong></div></div>}
        <div className="ai-feed">
          {!active&&!messages.length&&<div className="ai-empty"><h2>经营分析</h2></div>}
          {messages.map(m=><article className={`ai-message ${m.role}`} id={`ai-message-${m.id}`} key={m.id}>
            <div className="ai-message-label"><strong>{m.role==='user'?'我':'经营顾问'}</strong>{m.role==='assistant'&&m.content&&<button className="text-button" onClick={()=>void navigator.clipboard.writeText(m.content).catch(()=>setError('复制失败'))}>复制</button>}</div>
            {m.images?.length>0&&<div className="ai-message-images">{m.images.map((url,i)=><a key={i} href={url} target="_blank" rel="noreferrer"><img src={url} alt={`参考图片 ${i+1}`}/></a>)}</div>}
            <div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{img:({alt})=><span>{alt||'图片'}</span>,a:({children,href})=><a href={href} target="_blank" rel="noreferrer">{children}</a>}}>{m.content}</Markdown></div>
            {m.status==='interrupted'&&<p className="ai-message-note">已中断</p>}
            {m.status==='length'&&<button className="text-button" disabled={running} onClick={()=>void send('请从上次结尾继续，不要重复已输出内容。',[])}>继续生成</button>}
          </article>)}
          {busy&&<div className="ai-progress"><span/>{status||'分析中'}</div>}
        </div>
        {error&&<div className="message error ai-error">{error}<button className="text-button" onClick={()=>setError('')}>关闭</button></div>}
        <div className="ai-composer">
          {images.length>0&&<div className="ai-attachments">{images.map((url,i)=><div key={i}><img src={url} alt="待发送图片"/><button disabled={busy} aria-label={`移除图片 ${i+1}`} onClick={()=>setImages(old=>old.filter((_,n)=>n!==i))}>×</button></div>)}</div>}
          <textarea value={text} maxLength={50000} disabled={running} onChange={e=>setText(e.target.value)} placeholder="继续提问…" aria-label="提问" onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void send();}}}/>
          <div className="ai-compose-actions"><label className={`ai-upload${running?' disabled':''}`}>＋ 图片<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={running} onChange={e=>{void upload(e.target.files);e.target.value='';}}/></label>{busy?<button className="secondary" onClick={()=>controller.current?.abort()}>停止</button>:<button className="primary" disabled={running||!configured||(!text.trim()&&!images.length)} onClick={()=>void send()}>发送 ↑</button>}</div>
        </div>
      </div>
    </div>
    {memoryOpen&&<div className="ai-memory-overlay"><section className="ai-memory-panel"><div className="section-heading"><h3>经营背景</h3><button className="text-button" onClick={()=>setMemoryOpen(false)}>关闭</button></div><textarea aria-label="经营背景" rows={8} maxLength={12000} value={profile} onChange={e=>setProfile(e.target.value)} placeholder="商圈、营业时间、成本、活动、经营目标…"/><button className="primary" disabled={saving} onClick={async()=>{setSaving(true);try{await api('/api/business-ai/memory/profile',{method:'PUT',body:JSON.stringify({text:profile})});setMemoryOpen(false);}catch(e){setError((e as Error).message);}finally{setSaving(false);}}}>{saving?'保存中…':'保存'}</button>{memories.filter(m=>m.key.startsWith('automatic:')).map(m=><details key={m.key}><summary>{(m.content as {date_from:string;date_to:string}).date_from} 至 {(m.content as {date_to:string}).date_to}</summary><div className="ai-markdown"><Markdown remarkPlugins={[remarkGfm]}>{(m.content as {content:string}).content}</Markdown></div></details>)}</section></div>}
  </section>;
}
