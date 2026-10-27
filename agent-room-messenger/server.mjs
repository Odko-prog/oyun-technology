import http from 'node:http';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {sameSecret,validSignature,extractEvents} from './core.mjs';
import {operatorSchema,handleOperator,sendPage} from './operator.mjs';
const PAGE=process.env.META_PAGE_ID||'1309261702280978';
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:10000}):null;
let ready=false;
async function initialize(){if(!pool)return;await pool.query(`CREATE TABLE IF NOT EXISTS messenger_requests(id UUID PRIMARY KEY,source_id TEXT NOT NULL UNIQUE,sender_id TEXT NOT NULL,message_text TEXT NOT NULL,attachment_types JSONB NOT NULL,source_timestamp BIGINT,status TEXT NOT NULL DEFAULT 'received',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE TABLE IF NOT EXISTS messenger_notifications(id UUID PRIMARY KEY,request_id UUID NOT NULL REFERENCES messenger_requests(id),event_type TEXT NOT NULL,recipient TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(request_id,event_type));`);ready=true}
function reply(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))}
async function rawBody(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('TOO_LARGE');chunks.push(chunk)}return Buffer.concat(chunks)}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/operator/')){
   if(!process.env.OPERATOR_TOKEN||!sameSecret(req.headers.authorization,'Bearer '+process.env.OPERATOR_TOKEN))return reply(res,401,{error:'Unauthorized'});
   if(!ready)return reply(res,503,{error:'Storage unavailable'});
   let b={};if(req.method==='POST'){try{b=JSON.parse((await rawBody(req)).toString('utf8'))}catch{return reply(res,400,{error:'Invalid request'})}}
   const result=await handleOperator(url.pathname,req.method,b,pool);return reply(res,result.error?409:200,result);
  }
  if(req.method==='GET'&&url.pathname==='/health'){if(!ready)return reply(res,503,{ready:false});await pool.query('SELECT 1');return reply(res,200,{ready:true,webhookConfigured:Boolean(process.env.META_APP_SECRET&&process.env.META_VERIFY_TOKEN),emailDeliveryEnabled:false})}
  if(url.pathname==='/webhook'&&req.method==='GET'){
   if(!process.env.META_VERIFY_TOKEN||!ready)return reply(res,503,{error:'Not configured'});
   if(url.searchParams.get('hub.mode')==='subscribe'&&sameSecret(url.searchParams.get('hub.verify_token'),process.env.META_VERIFY_TOKEN)){
    const challenge=url.searchParams.get('hub.challenge')||'';if(challenge.length>1000)return reply(res,400,{error:'Invalid challenge'});res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});return res.end(challenge);
   }return reply(res,403,{error:'Verification failed'});
  }
  if(url.pathname==='/webhook'&&req.method==='POST'){
   if(!ready||!process.env.META_APP_SECRET)return reply(res,503,{error:'Not configured'});
   if(Number(req.headers['content-length']||0)>65536)return reply(res,413,{error:'Payload too large'});
   const raw=await rawBody(req);if(!validSignature(raw,req.headers['x-hub-signature-256'],process.env.META_APP_SECRET))return reply(res,403,{error:'Signature rejected'});
   let messages;try{messages=extractEvents(JSON.parse(raw.toString('utf8')),PAGE)}catch{return reply(res,400,{error:'Invalid event'})}
   const db=await pool.connect();try{await db.query('BEGIN');for(const m of messages){
    const id=randomUUID();const inserted=await db.query('INSERT INTO messenger_requests(id,source_id,sender_id,message_text,attachment_types,source_timestamp) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_id) DO NOTHING RETURNING id',[id,m.sourceId,m.senderId,m.text,JSON.stringify(m.attachments),m.timestamp]);
    if(inserted.rowCount&&process.env.NOTIFICATION_EMAIL)await db.query("INSERT INTO messenger_notifications(id,request_id,event_type,recipient) VALUES($1,$2,'new_request',$3) ON CONFLICT DO NOTHING",[randomUUID(),id,process.env.NOTIFICATION_EMAIL]);
   }await db.query('COMMIT')}catch{await db.query('ROLLBACK');throw Error('Storage unavailable')}finally{db.release()}
   // Acknowledge only after durable commit. Notification rows do not mean an email was sent.
   console.log(JSON.stringify({event:'webhook_committed',eventCount:messages.length}));
   return reply(res,200,{received:true});
  }
  if(req.method==='GET'&&url.pathname==='/operator/pending'){
   if(!process.env.OPERATOR_TOKEN||!sameSecret(req.headers.authorization,'Bearer '+process.env.OPERATOR_TOKEN))return reply(res,401,{error:'Unauthorized'});
   if(!ready)return reply(res,503,{error:'Storage unavailable'});
   const rows=await pool.query("SELECT id,status,created_at,attachment_types FROM messenger_requests WHERE status='received' ORDER BY created_at LIMIT 100");
   return reply(res,200,{requests:rows.rows});
  }
  return reply(res,404,{error:'Not found'});
 }catch(e){return reply(res,e.message==='TOO_LARGE'?413:503,{error:e.message==='TOO_LARGE'?'Payload too large':'Service unavailable'})}
});
await initialize().then(()=>ready?operatorSchema(pool):null).catch(()=>{ready=false;console.error('Database initialization unavailable');process.exitCode=1});
if(ready){server.listen(Number(process.env.PORT||10000),'0.0.0.0',()=>console.log('Messenger ingress listening'));}
process.on('SIGTERM',()=>server.close(()=>pool?.end().finally(()=>process.exit(0))));
