import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
const digest=s=>createHash('sha256').update(s).digest('hex');
const validId=x=>typeof x==='string'&&/^\d{1,30}$/.test(x);
const secret=()=>randomBytes(32).toString('hex');
function matches(value,hash){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))return false;return timingSafeEqual(Buffer.from(digest(value),'hex'),Buffer.from(hash,'hex'));}
function authorized(s,key,now){if(!s||!matches(key,s.deviceKeyHash)||s.state==='revoked'||now>=s.expiresAt)throw Error('Device session unavailable');}
function active(s,key,now){authorized(s,key,now);if(s.state!=='active')throw Error('Device owner confirmation required');}
export function inspectDeviceSession(session,key,now=Date.now()){
 authorized(session,key,now);
 return {id:session.id,pageId:session.pageId,state:session.state,expiresAt:session.expiresAt,customerReference:session.senderId?session.senderId.slice(-6):null,workspaceLabel:session.workspaceLabel??null,ownerConfirmedAt:session.ownerConfirmedAt};
}

// Persist only `session`, never the returned device key or pairing code. The
// device key goes to the local owner; the code alone never activates access.
export function createDeviceSession({pageId,senderId=null,label='Local agent'},now=Date.now()){
 if(pageId!=='1309261702280978'||(senderId!==null&&!validId(senderId))||typeof label!=='string'||label.length>80)throw Error('Invalid Page device scope');
 const key=secret(),code=secret();
 return {deviceKey:key,pairingCode:code,session:{id:randomUUID(),pageId,senderId,label,deviceKeyHash:digest(key),pairingCodeHash:digest(code),state:'pending_page',createdAt:now,expiresAt:now+10*60_000,ownerConfirmedAt:null,revokedAt:null}};
}
export function confirmPageBinding(session,{pageId,senderId,pairingCode},now=Date.now()){
 if(session.state!=='pending_page'||now>=session.expiresAt||session.pageId!==pageId||!validId(senderId)||(session.senderId!==null&&session.senderId!==senderId)||!matches(pairingCode,session.pairingCodeHash))throw Error('Page pairing rejected');
 return {...session,senderId,state:'pending_owner',pairingCodeHash:null};
}
export function confirmLocalOwner(session,key,{workspaceLabel,attended},now=Date.now()){
 authorized(session,key,now);
 if(session.state!=='pending_owner'||attended!==true||typeof workspaceLabel!=='string'||!workspaceLabel.trim()||workspaceLabel.length>120)throw Error('Explicit local owner confirmation required');
 // Only a display label is sent to the service, never an absolute host path.
 if(/[\\/:]/.test(workspaceLabel))throw Error('Workspace must be a non-path label');
 return {...session,state:'active',workspaceLabel,ownerConfirmedAt:now,expiresAt:now+8*60*60_000};
}
export function revokeDeviceSession(session,key,now=Date.now()){
 if(!matches(key,session.deviceKeyHash))throw Error('Device session unavailable');
 return {...session,state:'revoked',deviceKeyHash:null,pairingCodeHash:null,expiresAt:now,revokedAt:now};
}
export function makeDeviceTask(session,{pageId,senderId,requestId,goal},now=Date.now()){
 if(session.state!=='active'||now>=session.expiresAt||session.pageId!==pageId||session.senderId!==senderId)throw Error('Device task scope rejected');
 if(typeof requestId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)||typeof goal!=='string'||!goal.trim()||goal.length>12000)throw Error('Invalid device task');
 return {id:randomUUID(),sessionId:session.id,pageId,senderId,requestId,goal,goalHash:digest(goal),state:'awaiting_owner',createdAt:now,expiresAt:Math.min(session.expiresAt,now+30*60_000),leaseHash:null,resultHash:null};
}
function scopedTask(s,key,t,now){active(s,key,now);if(t.sessionId!==s.id||t.pageId!==s.pageId||t.senderId!==s.senderId||now>=t.expiresAt||digest(t.goal)!==t.goalHash)throw Error('Device task unavailable');}
export function acceptDeviceTask(session,key,task,{approvedGoalHash},now=Date.now()){
 scopedTask(session,key,task,now);
 if(task.state!=='awaiting_owner'||approvedGoalHash!==task.goalHash)throw Error('Task approval rejected');
 const lease=secret();return {lease,task:{...task,state:'running',acceptedAt:now,leaseHash:digest(lease)}};
}
export function finishDeviceTask(session,key,task,{lease,result},now=Date.now()){
 scopedTask(session,key,task,now);
 if(!matches(lease,task.leaseHash)||!['running','result_ready'].includes(task.state))throw Error('Device result rejected');
 if(!result||typeof result.summary!=='string'||!result.summary.trim()||result.summary.length>1800||typeof result.verification!=='string'||!result.verification.trim()||result.verification.length>4000||!Array.isArray(result.files)||result.files.length>8)throw Error('Invalid device result');
 // File bytes are verified and stored by the transport adapter before this
 // transition; only verified metadata belongs in the durable task record.
 for(const f of result.files)if(!f||typeof f.name!=='string'||!/^[\p{L}\p{N} _().-]{1,120}$/u.test(f.name)||f.name.startsWith('.')||f.name.includes('..')||!Number.isInteger(f.bytes)||f.bytes<1||f.bytes>5_000_000||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid verified device artifact');
 if(result.files.reduce((n,f)=>n+f.bytes,0)>10_000_000)throw Error('Device artifact transport limit');
 const hash=digest(JSON.stringify(result));if(task.state==='result_ready'&&task.resultHash!==hash)throw Error('Device result already finalized');
 return {...task,state:'result_ready',resultHash:hash,result:structuredClone(result),finishedAt:task.finishedAt??now};
}
export function rejectDeviceTask(session,key,task,now=Date.now()){
 scopedTask(session,key,task,now);
 if(task.state!=='awaiting_owner')throw Error('Task already decided');
 return {...task,state:'declined',declinedAt:now,leaseHash:null};
}
export function cancelOwnedDeviceTask(session,key,task,{lease},now=Date.now()){
 scopedTask(session,key,task,now);
 if(task.state!=='running'||!matches(lease,task.leaseHash))throw Error('Running task cancellation rejected');
 return {...task,state:'cancelled',leaseHash:null,cancelledAt:now};
}
export function cancelDeviceTask(task,session,now=Date.now()){
 if(task.sessionId!==session.id)throw Error('Device task scope rejected');
 if(session.state!=='revoked'&&now<session.expiresAt&&now<task.expiresAt)throw Error('Session is still active');
 if(!['awaiting_owner','running','result_ready'].includes(task.state))return task;
 return {...task,state:'cancelled',leaseHash:null,cancelledAt:now};
}
// `result_ready` is not Messenger-delivered. The existing send-once transport
// must record its provider receipt separately before reporting completion.
