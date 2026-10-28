import {createHash} from 'node:crypto';
import {transaction} from './device-store.mjs';
import {makeDeviceTask,inspectDeviceSession,acceptDeviceTask,rejectDeviceTask,finishDeviceTask,cancelDeviceTask,cancelOwnedDeviceTask} from './device-protocol.mjs';
import {saveArtifacts,composeDelivery} from './artifacts.mjs';
const PAGE='1309261702280978';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
export async function deviceTaskSchema(pool){await pool.query(`CREATE TABLE IF NOT EXISTS messenger_device_tasks(id UUID PRIMARY KEY,session_id UUID NOT NULL REFERENCES messenger_devices(id),request_id UUID NOT NULL REFERENCES messenger_requests(id),record JSONB NOT NULL,delivery_state TEXT NOT NULL DEFAULT 'pending',delivery_text TEXT,provider_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(session_id,request_id)); CREATE INDEX IF NOT EXISTS messenger_device_tasks_queue ON messenger_device_tasks(session_id,delivery_state,created_at);`);}
export async function activeCustomerDevices(pool,senderId,now=Date.now()){
 return (await pool.query("SELECT id,record->>'label' AS label,record->>'workspaceLabel' AS workspace_label FROM messenger_devices WHERE record->>'senderId'=$1 AND record->>'pageId'=$2 AND record->>'state'='active' AND expires_at>$3 ORDER BY id LIMIT 5",[senderId,PAGE,now])).rows.map(x=>({...x,online:'not_verified',attended:true}));
}
export async function enqueueDeviceTask(pool,job,{session_id,goal},now=Date.now()){
 if(!uuid(session_id))throw Error('Invalid device reference');
 return transaction(pool,async db=>{
  const session=(await db.query('SELECT record FROM messenger_devices WHERE id=$1 FOR UPDATE',[session_id])).rows[0]?.record;
  if(!session)throw Error('Device unavailable');
  const original=await db.query("SELECT id FROM messenger_requests WHERE id=$1 AND sender_id=$2 AND lease=$3 AND status='processing' AND lease_until>NOW()",[job.id,job.sender_id,job.lease]);
  if(original.rows.length!==1)throw Error('Original request lease unavailable');
  const task=makeDeviceTask(session,{pageId:PAGE,senderId:job.sender_id,requestId:job.id,goal},now);
  const existing=(await db.query('SELECT record FROM messenger_device_tasks WHERE session_id=$1 AND request_id=$2',[session_id,job.id])).rows[0]?.record;
  if(existing){if(existing.goalHash!==task.goalHash)throw Error('Device task already fixed');return {id:existing.id,state:existing.state};}
  await db.query('INSERT INTO messenger_device_tasks(id,session_id,request_id,record) VALUES($1,$2,$3,$4)',[task.id,session_id,job.id,JSON.stringify(task)]);
  return {id:task.id,state:task.state};
 });
}
export function decodeDeviceArtifacts(files){
 if(!Array.isArray(files)||files.length>8)throw Error('Device file count limit');
 let total=0;const names=new Set();
 return files.map(f=>{
  if(!f||typeof f.name!=='string'||! /^[\p{L}\p{N} _().-]{1,120}$/u.test(f.name)||f.name.startsWith('.')||f.name.includes('..')||names.has(f.name)||typeof f.mime!=='string'||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(f.mime)||typeof f.base64!=='string'||f.base64.length>6_666_668||! /^[A-Za-z0-9+/]*={0,2}$/.test(f.base64))throw Error('Invalid device file');
  const bytes=Buffer.from(f.base64,'base64');total+=bytes.length;
  if(!bytes.length||bytes.length>5_000_000||total>10_000_000||bytes.toString('base64')!==f.base64)throw Error('Device file size/encoding limit');
  const sha256=createHash('sha256').update(bytes).digest('hex');if(f.sha256!==sha256)throw Error('Device file hash mismatch');
  names.add(f.name);return {name:f.name,mime:f.mime,bytes,sha256};
 });
}
function ownerSession(session,key,now){const view=inspectDeviceSession(session,key,now);if(view.state!=='active')throw Error('Local owner confirmation required');return view;}
export async function pendingDeviceTasks(pool,id,key,now=Date.now()){
 if(!uuid(id))throw Error('Device session unavailable');
 return transaction(pool,async db=>{
  const s=(await db.query('SELECT record FROM messenger_devices WHERE id=$1 FOR UPDATE',[id])).rows[0]?.record;ownerSession(s,key,now);
  // Do not start local work unless the cloud's initial acknowledgment has a
  // persisted provider receipt. An uncertain cloud send is held for review.
  const rows=(await db.query("SELECT t.record FROM messenger_device_tasks t JOIN messenger_requests r ON r.id=t.request_id WHERE t.session_id=$1 AND t.record->>'senderId'=$2 AND r.sender_id=$2 AND r.provider_id IS NOT NULL AND r.status='awaiting_customer' AND t.record->>'state'='awaiting_owner' AND (t.record->>'expiresAt')::BIGINT>$3 ORDER BY t.created_at LIMIT 10",[id,s.senderId,now])).rows;
  return rows.map(({record:t})=>({id:t.id,requestId:t.requestId,goal:t.goal,goalHash:t.goalHash,state:t.state,expiresAt:t.expiresAt}));
 });
}
export async function deviceTaskOperation(pool,id,key,taskId,operation,body={},now=Date.now()){
 if(!uuid(id)||!uuid(taskId))throw Error('Device task unavailable');
 return transaction(pool,async db=>{
  const session=(await db.query('SELECT record FROM messenger_devices WHERE id=$1 FOR UPDATE',[id])).rows[0]?.record;ownerSession(session,key,now);
  const row=(await db.query('SELECT record,delivery_state,provider_id FROM messenger_device_tasks WHERE id=$1 AND session_id=$2 FOR UPDATE',[taskId,id])).rows[0];
  if(!row||row.record.senderId!==session.senderId)throw Error('Device task unavailable');
  let task=row.record;let lease;
  if(operation==='status'&&now>=task.expiresAt){task=cancelDeviceTask(task,session,now);await db.query('UPDATE messenger_device_tasks SET record=$2 WHERE id=$1',[taskId,JSON.stringify(task)]);}
  if(operation==='accept'){
   const parent=(await db.query("SELECT id FROM messenger_requests WHERE id=$1 AND sender_id=$2 AND provider_id IS NOT NULL AND status='awaiting_customer'",[task.requestId,task.senderId])).rows;
   if(parent.length!==1)throw Error('Original acknowledgment unavailable');
   const accepted=acceptDeviceTask(session,key,task,body,now);task=accepted.task;lease=accepted.lease;
  }else if(operation==='decline')task=rejectDeviceTask(session,key,task,now);
  else if(operation==='cancel')task=cancelOwnedDeviceTask(session,key,task,body,now);
  else if(operation==='result'){
   if(row.delivery_state!=='pending')throw Error('Device result already submitted');
   const files=decodeDeviceArtifacts(body.files);
   const result={summary:body.summary,verification:body.verification,files:files.map(f=>({name:f.name,bytes:f.bytes.length,sha256:f.sha256}))};
   const next=finishDeviceTask(session,key,task,{lease:body.lease,result},now);
   if(task.state!=='result_ready'){
    const links=await saveArtifacts(db,{id:task.requestId,sender_id:task.senderId},files);
    await db.query("UPDATE messenger_device_tasks SET delivery_text=$2 WHERE id=$1",[taskId,composeDelivery(result.summary,links)]);
   }
   task=next;
  }else if(operation!=='status')throw Error('Unsupported device task operation');
  if(operation!=='status')await db.query('UPDATE messenger_device_tasks SET record=$2 WHERE id=$1',[taskId,JSON.stringify(task)]);
  return {id:task.id,state:task.state,goalHash:task.goalHash,...(lease?{lease}:{}),deliveryState:row.delivery_state,delivered:Boolean(row.provider_id)};
 });
}
export async function dispatchOneDeviceResult(pool,send,{now=Date.now()}={}){
 await pool.query("UPDATE messenger_device_tasks t SET delivery_state='cancelled',record=jsonb_set(jsonb_set(t.record,'{state}','\"cancelled\"'),'{leaseHash}','null') FROM messenger_devices d WHERE d.id=t.session_id AND t.delivery_state='pending' AND t.record->>'state' IN ('awaiting_owner','running','result_ready') AND (d.record->>'state'<>'active' OR d.expires_at<=$1 OR (t.record->>'expiresAt')::BIGINT<=$1)",[now]);
 // Commit dispatching BEFORE any provider call; crashed/uncertain attempts are
 // never picked up again automatically.
 const claim=await pool.query("WITH next AS (SELECT t.id FROM messenger_device_tasks t JOIN messenger_devices d ON d.id=t.session_id WHERE t.delivery_state='pending' AND t.record->>'state'='result_ready' AND d.record->>'state'='active' AND d.expires_at>$1 ORDER BY t.created_at FOR UPDATE OF t SKIP LOCKED LIMIT 1) UPDATE messenger_device_tasks t SET delivery_state='dispatching' FROM next WHERE t.id=next.id RETURNING t.id,t.session_id,t.request_id,t.record,t.delivery_text",[now]);
 if(!claim.rows.length)return null;const t=claim.rows[0];
 try{
  return await transaction(pool,async db=>{
   // Serialize the final provider call against owner revocation. Revocation
   // committed before this lock always prevents the send.
   const session=(await db.query('SELECT record FROM messenger_devices WHERE id=$1 FOR UPDATE',[t.session_id])).rows[0]?.record;
   const request=(await db.query('SELECT sender_id FROM messenger_requests WHERE id=$1',[t.request_id])).rows[0];
   if(!session||session.state!=='active'||session.expiresAt<=Date.now()||session.senderId!==t.record.senderId||request?.sender_id!==t.record.senderId)throw Error('Device delivery scope unavailable');
   const providerId=await send(request.sender_id,t.delivery_text);if(typeof providerId!=='string'||!providerId)throw Error('Missing provider receipt');
   await db.query("UPDATE messenger_device_tasks SET delivery_state='sent',provider_id=$2,record=jsonb_set(record,'{state}','\"delivered\"') WHERE id=$1 AND delivery_state='dispatching'",[t.id,providerId]);
   return {id:t.id,sent:true};
  });
 }catch{
  await pool.query("UPDATE messenger_device_tasks SET delivery_state='review' WHERE id=$1 AND delivery_state='dispatching'",[t.id]).catch(()=>{});
  return {id:t.id,sent:false,review:true};
 }
}
