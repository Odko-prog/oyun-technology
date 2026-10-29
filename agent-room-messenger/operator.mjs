import {randomUUID} from 'node:crypto';
import {ownerJobNotice} from './job-status.mjs';
export async function operatorSchema(pool){await pool.query(`ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS lease UUID; ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ; ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS reply_text TEXT; ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS provider_id TEXT; ALTER TABLE messenger_notifications ADD COLUMN IF NOT EXISTS provider_id TEXT; ALTER TABLE messenger_notifications ADD COLUMN IF NOT EXISTS lease UUID; ALTER TABLE messenger_notifications ADD COLUMN IF NOT EXISTS attempted_at TIMESTAMPTZ;`)}
const uuid=x=>typeof x==='string'&&/^[0-9a-f-]{36}$/i.test(x);
export async function sendPage(recipient,text){
 if(!process.env.PAGE_ACCESS_TOKEN)throw Error('Page sender not configured');
 if(!/^\d{1,30}$/.test(String(recipient))||typeof text!=='string'||text.length>1900)throw Error('Invalid delivery');
 const r=await fetch(`https://graph.facebook.com/v26.0/${process.env.META_PAGE_ID||'1309261702280978'}/messages`,{method:'POST',headers:{Authorization:'Bearer '+process.env.PAGE_ACCESS_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({recipient:{id:String(recipient)},messaging_type:'RESPONSE',message:{text}}),signal:AbortSignal.timeout(20000)});
 const data=await r.json();if(!r.ok||!data.message_id)throw Error('Page delivery requires review');return data.message_id;
}
export async function handleOperator(path,method,b,pool){
 if(path==='/operator/pending'&&method==='GET'){
  const requests=(await pool.query('SELECT id,source_id,sender_id,message_text,status,created_at,attachment_types FROM messenger_requests ORDER BY created_at DESC LIMIT 100')).rows;
  // Aggregate the entire durable queue: the newest100 are not a completeness proof.
  // A review without a receipt may already have a desktop delivery; never auto-retry it.
  const summary=(await pool.query(`SELECT COUNT(*)::INT AS total,COUNT(*) FILTER(WHERE status='received')::INT AS queued,COUNT(*) FILTER(WHERE status='processing')::INT AS running,COUNT(*) FILTER(WHERE status='dispatching')::INT AS dispatching,COUNT(*) FILTER(WHERE status='received' AND created_at<NOW()-INTERVAL '2 minutes')::INT AS queued_over_2m,COUNT(*) FILTER(WHERE status IN ('processing','dispatching') AND lease_until<NOW())::INT AS expired_leases,COUNT(*) FILTER(WHERE status='review')::INT AS review,COUNT(*) FILTER(WHERE status='review' AND provider_id IS NULL)::INT AS review_without_api_receipt,MIN(created_at) FILTER(WHERE status='received') AS oldest_queued_at FROM messenger_requests`)).rows[0];
  return {requests,queueSummary:summary};
 }
 if(path==='/operator/claim'&&method==='POST'){
  // A crashed worker is held for review. Never blindly repeat an uncertain delivery.
  await pool.query("UPDATE messenger_requests SET status='review' WHERE status IN ('processing','dispatching') AND lease_until<NOW()");
  if(!process.env.PAGE_ACCESS_TOKEN)return {blocked:'Page sender not configured'};
  const lease=randomUUID();const row=await pool.query("WITH next AS (SELECT id FROM messenger_requests WHERE status='received' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE messenger_requests AS r SET status='processing',lease=$1,lease_until=NOW()+INTERVAL '10 minutes' FROM next WHERE r.id=next.id RETURNING r.id,r.sender_id,r.message_text,r.attachment_types,r.attachment_refs,r.device_pairing,r.created_at,r.lease",[lease]);return {request:row.rows[0]||null};
 }
 if(path==='/operator/result'&&method==='POST'){
  if(!uuid(b.id)||!uuid(b.lease)||typeof b.reply!=='string'||!b.reply.trim()||b.reply.length>1800||!['awaiting_customer','review','completed'].includes(b.status))return {error:'Invalid result'};
  const changed=await pool.query("UPDATE messenger_requests SET status='dispatching',reply_text=$3 WHERE id=$1 AND lease=$2 AND status='processing' AND lease_until>NOW() RETURNING sender_id",[b.id,b.lease,b.reply]);if(!changed.rowCount)return {error:'Lease conflict'};
  try{const mid=await sendPage(changed.rows[0].sender_id,b.reply);await pool.query('UPDATE messenger_requests SET status=$2,provider_id=$3,lease_until=NULL WHERE id=$1',[b.id,b.status,mid]);return {sent:true,message_id:mid}}catch{await pool.query("UPDATE messenger_requests SET status='review',lease_until=NULL WHERE id=$1",[b.id]);return {sent:false,needsReview:true}};
 }
 if(path==='/operator/owner-test'&&method==='POST'){
  if(!process.env.OWNER_PSID)return {error:'Owner not paired'};
  return {message_id:await sendPage(process.env.OWNER_PSID,'«Агентуудын өрөө» — серверээс таны Messenger-т мэдэгдэл хүргэх автомат холболтын туршилт. Энэ нь хэрэглэгчийн ажил дууссан гэсэн мэдэгдэл биш.')};
 }
 if(path==='/operator/owner-notify'&&method==='POST'){
  if(!uuid(b.id)||!process.env.OWNER_PSID)return {error:'Owner not paired'};
  const q=await pool.query('SELECT sender_id,status,provider_id FROM messenger_requests WHERE id=$1',[b.id]);if(!q.rowCount)return {error:'Request not found'};
  if(q.rows[0].sender_id===process.env.OWNER_PSID)return {skipped:'owner request'};
  const n=await pool.query("INSERT INTO messenger_notifications(id,request_id,event_type,recipient,status,attempted_at) VALUES($1,$2,'owner_messenger',$3,'processing',NOW()) ON CONFLICT DO NOTHING RETURNING id",[randomUUID(),b.id,process.env.OWNER_PSID]);if(!n.rowCount)return {skipped:'already attempted'};
  try{const mid=await sendPage(process.env.OWNER_PSID,ownerJobNotice(b.id,q.rows[0]));await pool.query("UPDATE messenger_notifications SET status='sent',provider_id=$2 WHERE id=$1",[n.rows[0].id,mid]);return {sent:true}}catch{await pool.query("UPDATE messenger_notifications SET status='review' WHERE id=$1",[n.rows[0].id]);return {sent:false,needsReview:true}};
 }
 if(path==='/operator/mail/claim'&&method==='POST'){
  const lease=randomUUID();const row=await pool.query("WITH next AS (SELECT id FROM messenger_notifications WHERE status='pending' AND event_type='new_request' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE messenger_notifications AS n SET status='processing',lease=$1,attempted_at=NOW() FROM next WHERE n.id=next.id RETURNING n.id,n.request_id,n.lease",[lease]);return {notification:row.rows[0]||null};
 }
 if(path==='/operator/mail/result'&&method==='POST'){
  if(!uuid(b.id)||!uuid(b.lease)||!['sent','review'].includes(b.status))return {error:'Invalid notification result'};
  const done=await pool.query("UPDATE messenger_notifications SET status=$3,provider_id=$4 WHERE id=$1 AND lease=$2 AND status='processing'",[b.id,b.lease,b.status,String(b.provider_id||'').slice(0,200)]);return {updated:done.rowCount===1};
 }
 return {error:'Unsupported operation'};
}

