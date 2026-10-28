import {createHash} from 'node:crypto';
import {createDeviceSession,confirmPageBinding,confirmLocalOwner,revokeDeviceSession,inspectDeviceSession} from './device-protocol.mjs';
const PAGE='1309261702280978';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
export async function deviceSchema(pool){await pool.query(`ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS device_pairing BOOLEAN NOT NULL DEFAULT FALSE; CREATE TABLE IF NOT EXISTS messenger_devices(id UUID PRIMARY KEY,record JSONB NOT NULL,expires_at BIGINT NOT NULL); CREATE INDEX IF NOT EXISTS messenger_devices_expiry ON messenger_devices(expires_at); CREATE INDEX IF NOT EXISTS messenger_devices_pair ON messenger_devices((record->>'pairingCodeHash')) WHERE record->>'state'='pending_page';`);}
export async function transaction(pool,fn){const db=await pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}}
async function write(db,session){await db.query('UPDATE messenger_devices SET record=$2,expires_at=$3 WHERE id=$1',[session.id,JSON.stringify(session),session.expiresAt]);}
export async function startStoredDevice(pool,{label='Local agent'}={},now=Date.now()){
 return transaction(pool,async db=>{
  // Bound anonymous enrollment: no file/process access exists at this stage.
  await db.query('SELECT pg_advisory_xact_lock(1309261702,280979)');
  // Never-activated anonymous challenges cannot have tasks. Drop expired ones
  // so a bounded concurrent enrollment cap does not become unbounded storage.
  await db.query("DELETE FROM messenger_devices WHERE expires_at<=$1 AND record->>'state' IN ('pending_page','pending_owner')",[now]);
  const count=(await db.query('SELECT COUNT(*)::int AS count FROM messenger_devices WHERE expires_at>$1',[now])).rows[0].count;
  if(count>=100)throw Error('Device enrollment capacity reached');
  const created=createDeviceSession({pageId:PAGE,label},now);
  await db.query('INSERT INTO messenger_devices(id,record,expires_at) VALUES($1,$2,$3)',[created.session.id,JSON.stringify(created.session),created.session.expiresAt]);
  return {sessionId:created.session.id,deviceKey:created.deviceKey,pairingCode:created.pairingCode,expiresAt:created.session.expiresAt,pageId:PAGE};
 });
}
// Only call inside the verified target-Page webhook transaction. Neither the
// public device API nor the local agent may choose a Messenger sender identity.
export async function bindStoredDeviceFromSignedPage(db,{pageId,senderId,text},now=Date.now()){
 const code=typeof text==='string'?/^AGENT-CONNECT ([a-f0-9]{64})$/i.exec(text.trim()):null;
 if(pageId!==PAGE||!code)return false;
 const hash=createHash('sha256').update(code[1].toLowerCase()).digest('hex');
 const q=await db.query("SELECT record FROM messenger_devices WHERE record->>'pairingCodeHash'=$1 AND record->>'state'='pending_page' AND expires_at>$2 FOR UPDATE",[hash,now]);
 if(q.rows.length!==1)return false;
 const bound=confirmPageBinding(q.rows[0].record,{pageId,senderId,pairingCode:code[1].toLowerCase()},now);
 await write(db,bound);return true;
}
export async function deviceOwnerOperation(pool,id,key,operation,body={},now=Date.now()){
 if(!uuid(id))throw Error('Device session unavailable');
 return transaction(pool,async db=>{
  const q=await db.query('SELECT record FROM messenger_devices WHERE id=$1 FOR UPDATE',[id]);
  if(q.rows.length!==1)throw Error('Device session unavailable');
  let session=q.rows[0].record;
  inspectDeviceSession(session,key,now);
  if(operation==='activate')session=confirmLocalOwner(session,key,body,now);
  else if(operation==='revoke'){
   session=revokeDeviceSession(session,key,now);await write(db,session);
   return {id:session.id,state:'revoked',expiresAt:now};
  }else if(operation!=='status')throw Error('Unsupported device operation');
  if(operation==='activate')await write(db,session);
  return inspectDeviceSession(session,key,now);
 });
}
export async function handleDeviceRequest(path,method,body,authorization,pool,{enabled=false,now=Date.now()}={}){
 if(!path.startsWith('/device/'))return null;
 if(!enabled)return {status:503,body:{error:'Attended device bridge is not enabled'}};
 try{
  if(path==='/device/start'&&method==='POST')return {status:201,body:await startStoredDevice(pool,{label:body.label},now)};
  const taskRoute=/^\/device\/([a-f0-9-]{36})\/tasks(?:\/([a-f0-9-]{36})\/(status|accept|decline|cancel|result))?$/.exec(path);
  if(taskRoute){
   const key=typeof authorization==='string'?/^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1]:null;
   if(!key)return {status:404,body:{error:'Device session unavailable'}};
   const {pendingDeviceTasks,deviceTaskOperation}=await import('./device-tasks.mjs');
   if(!taskRoute[2]&&method==='GET')return {status:200,body:{tasks:await pendingDeviceTasks(pool,taskRoute[1],key,now)}};
   if(taskRoute[2]&&((taskRoute[3]==='status'&&method==='GET')||(taskRoute[3]!=='status'&&method==='POST')))return {status:200,body:await deviceTaskOperation(pool,taskRoute[1],key,taskRoute[2],taskRoute[3],body,now)};
   return {status:404,body:{error:'Not found'}};
  }
  const m=/^\/device\/([a-f0-9-]{36})\/(status|activate|revoke)$/.exec(path);
  if(!m||!((m[2]==='status'&&method==='GET')||(m[2]!=='status'&&method==='POST')))return {status:404,body:{error:'Not found'}};
  const key=typeof authorization==='string'?/^Bearer ([a-f0-9]{64})$/.exec(authorization)?.[1]:null;
  if(!key)return {status:404,body:{error:'Device session unavailable'}};
  return {status:200,body:await deviceOwnerOperation(pool,m[1],key,m[2],body,now)};
 }catch{return {status:409,body:{error:'Device session unavailable or owner confirmation incomplete'}};}
}
