import {extractEvents} from './core.mjs';
import {PAGE_ID} from './bataar-schedule.mjs';
import {generateBataar} from './bataar-worker.mjs';

export async function bataarMessengerSchema(db){
  await db.query(`CREATE TABLE IF NOT EXISTS bataar_messenger_requests(
    source_id TEXT PRIMARY KEY,page_id TEXT NOT NULL CHECK(page_id='440088839501409'),sender_id TEXT NOT NULL,
    message_text TEXT NOT NULL,source_timestamp BIGINT,status TEXT NOT NULL DEFAULT 'received',
    reply_text TEXT,provider_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS bataar_messenger_handoffs(sender_id TEXT PRIMARY KEY,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
}
// Called ONLY after the server has verified the Meta HMAC, inside its durable transaction.
export async function acceptBataarMessages(db,event,{enabled=false}={}){
  if(!enabled)return 0;
  let count=0;
  for(const m of extractEvents(event,PAGE_ID)){
    if(m.senderId===PAGE_ID)continue;
    const r=await db.query(`INSERT INTO bataar_messenger_requests(source_id,page_id,sender_id,message_text,source_timestamp)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id) DO NOTHING RETURNING source_id`,[m.sourceId,PAGE_ID,m.senderId,m.text,m.timestamp]);
    count+=r.rowCount;
  }
  return count;
}
export function withinReplyWindow(timestamp,now=Date.now()){
  const n=Number(timestamp);return Number.isFinite(n)&&n>0&&n<=now+60000&&now-n<23*3600000;
}
export function validateMessengerDraft(draft){
  if(draft?.verified!==true||typeof draft.message!=='string'||draft.message.trim().length<10||draft.message.length>1500)throw Error('Unverified reply');
  if(/EAA[A-Za-z0-9]{40,}|sk-[A-Za-z0-9_-]{20,}/.test(draft.message))throw Error('Sensitive output');
  return 'AI туслах: '+draft.message.replace(/^AI туслах[:：]?\s*/,'').trim();
}
export function messengerClient(env,fetcher=fetch){
  async function request(path,body){
    const token=env.BATAAR_MESSENGER_PAGE_ACCESS_TOKEN;if(!token)throw Error('Messenger token missing');
    const response=await fetcher('https://graph.facebook.com/v26.0/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    const data=await response.json();if(!response.ok||data.error)throw Error('Messenger authorization or delivery requires review');return data;
  }
  return {identity:()=>request('me?fields=id,name'),async send(event,text){
    if(event.page_id!==PAGE_ID||!/^\d{1,30}$/.test(event.sender_id)||event.sender_id===PAGE_ID||!withinReplyWindow(event.source_timestamp))throw Error('Recipient or reply window rejected');
    const sent=await request(PAGE_ID+'/messages',{messaging_type:'RESPONSE',recipient:{id:event.sender_id},message:{text}});
    if(sent.recipient_id!==event.sender_id||!sent.message_id)throw Error('Uncertain delivery');return sent.message_id;
  }};
}
export async function processBataarMessage(pool,event,{generate=generateBataar,send,env=process.env,signal}={}){
  async function finish(status,reply=null,provider=null){await pool.query('UPDATE bataar_messenger_requests SET status=$2,reply_text=$3,provider_id=$4,updated_at=NOW() WHERE source_id=$1',[event.source_id,status,reply,provider]);return status;}
  if(event.page_id!==PAGE_ID||!withinReplyWindow(event.source_timestamp))return finish('expired');
  if((await pool.query('SELECT sender_id FROM bataar_messenger_handoffs WHERE sender_id=$1',[event.sender_id])).rowCount)return finish('human-handoff');
  const wantsHuman=/\b(stop|unsubscribe|human|operator)\b|хүнтэй|хүний оператор|устгуу|битгий хариу|зогсоо/i.test(event.message_text);
  if(wantsHuman)await pool.query('INSERT INTO bataar_messenger_handoffs(sender_id) VALUES($1) ON CONFLICT DO NOTHING',[event.sender_id]);
  try{
    const history=(await pool.query("SELECT message_text,reply_text FROM bataar_messenger_requests WHERE page_id=$1 AND sender_id=$2 AND source_id<>$3 AND status='sent' ORDER BY created_at DESC LIMIT 8",[PAGE_ID,event.sender_id,event.source_id])).rows.reverse();
    const message=wantsHuman?'AI туслах: Хүний ажилтантай холбогдох хүсэлтийг тэмдэглэлээ. Автомат хариуг энэ ярианд зогсоолоо. Баазтай 99530099 дугаараар холбогдоно уу.':validateMessengerDraft(await generate({kind:'messenger',message:event.message_text||'[Зөвхөн хавсралт ирсэн; агуулгыг нээгээгүй]',history},{env,signal}));
    if(signal?.aborted||!withinReplyWindow(event.source_timestamp))return finish('expired');
    await finish('dispatching',message); // An uncertain POST must never be automatically repeated.
    const id=await send(event,message);return finish('sent',message,id);
  }catch{return finish('review');}
}
export function startBataarMessenger(pool,{env=process.env,generate=generateBataar,fetcher=fetch}={}){
  const state={enabled:env.BATAAR_MESSENGER_ENABLED==='true',status:'disabled',pageId:PAGE_ID,identityVerified:false,generatorVerified:false,lastPoll:null,lastResult:null};
  let stopping=false,wake;const abort=new AbortController();const client=messengerClient(env,fetcher);
  const done=(async()=>{
    if(!state.enabled)return;
    try{
      const who=await client.identity();if(who.id!==PAGE_ID||who.name!=='Motherland Of Bataar')throw Error('Wrong Page');state.identityVerified=true;
      validateMessengerDraft(await generate({kind:'messenger',message:'Танай бааз хаана байдаг вэ?',history:[],preflight:true},{env,signal:abort.signal}));state.generatorVerified=true;
      state.status='ready';
      while(!stopping){
        state.lastPoll=new Date().toISOString();
        const claimed=await pool.query(`UPDATE bataar_messenger_requests SET status='generating',updated_at=NOW()
          WHERE source_id=(SELECT source_id FROM bataar_messenger_requests WHERE status='received' AND page_id=$1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
          AND status='received' RETURNING *`,[PAGE_ID]);
        if(claimed.rowCount){state.lastResult=await processBataarMessage(pool,claimed.rows[0],{generate,send:client.send,env,signal:abort.signal});continue;}
        await new Promise(resolve=>{const timer=setTimeout(resolve,10000);wake=()=>{clearTimeout(timer);resolve();};});wake=null;
      }
    }catch{state.status='authorization-or-runtime-review-required';}
  })();
  return {state,done,async stop(){stopping=true;abort.abort();wake?.();await done;}};
}
