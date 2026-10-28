import test from 'node:test';
import assert from 'node:assert/strict';
import {createDeviceSession,confirmPageBinding,confirmLocalOwner,makeDeviceTask,acceptDeviceTask,finishDeviceTask,revokeDeviceSession,cancelDeviceTask,rejectDeviceTask} from './device-protocol.mjs';
const pageId='1309261702280978',senderId='12345',now=1_700_000_000_000;
function paired(){const p=createDeviceSession({pageId,senderId},now);p.session=confirmPageBinding(p.session,{pageId,senderId,pairingCode:p.pairingCode},now+1);p.session=confirmLocalOwner(p.session,p.deviceKey,{workspaceLabel:'Shop workspace',attended:true},now+2);return p;}
const requestId='12345678-0000-4000-8000-123456789012';
test('pairing needs the exact Page customer AND local owner; durable record contains only secret hashes',()=>{
 const p=createDeviceSession({pageId,senderId},now);const serialized=JSON.stringify(p.session);assert.ok(!serialized.includes(p.deviceKey));assert.ok(!serialized.includes(p.pairingCode));
 assert.throws(()=>confirmLocalOwner(p.session,p.deviceKey,{workspaceLabel:'Shop',attended:true},now+1));
 assert.throws(()=>confirmPageBinding(p.session,{pageId,senderId:'67890',pairingCode:p.pairingCode},now+1));
 assert.throws(()=>confirmPageBinding(p.session,{pageId,senderId,pairingCode:p.pairingCode},now+600_000));
 assert.throws(()=>createDeviceSession({pageId:'440088839501409',senderId},now));
 const s=confirmPageBinding(p.session,{pageId,senderId,pairingCode:p.pairingCode},now+1);assert.equal(s.pairingCodeHash,null);
 assert.throws(()=>confirmLocalOwner(s,p.deviceKey,{workspaceLabel:'C:/private',attended:true},now+2));
 assert.throws(()=>confirmLocalOwner(s,p.deviceKey,{workspaceLabel:'Shop',attended:false},now+2));
});
test('every local task needs approval of exact unchanged goal and the device lease',()=>{
 const p=paired();const t=makeDeviceTask(p.session,{pageId,senderId,requestId,goal:'Summarize supplied shop stock'},now+3);
 assert.throws(()=>makeDeviceTask(p.session,{pageId,senderId:'67890',requestId,goal:'x'},now+3));
 assert.throws(()=>acceptDeviceTask(p.session,p.deviceKey,t,{approvedGoalHash:'wrong'},now+4));
 assert.throws(()=>acceptDeviceTask(p.session,p.deviceKey,{...t,goal:'Altered command'},{approvedGoalHash:t.goalHash},now+4));
 const accepted=acceptDeviceTask(p.session,p.deviceKey,t,{approvedGoalHash:t.goalHash},now+4);
 const result={summary:'Verified result',verification:'Actual file hash checked',files:[{name:'result.csv',bytes:10,sha256:'a'.repeat(64)}]};
 assert.throws(()=>finishDeviceTask(p.session,p.deviceKey,accepted.task,{lease:'0'.repeat(64),result},now+5));
 const ready=finishDeviceTask(p.session,p.deviceKey,accepted.task,{lease:accepted.lease,result},now+5);assert.equal(ready.state,'result_ready');assert.ok(!('provider_id' in ready));
 assert.deepEqual(finishDeviceTask(p.session,p.deviceKey,ready,{lease:accepted.lease,result},now+6),ready);
 assert.throws(()=>finishDeviceTask(p.session,p.deviceKey,ready,{lease:accepted.lease,result:{...result,summary:'Different result'}},now+6));
});
test('revocation and expiry invalidate running tasks and forbid new work/results',()=>{
 const p=paired(),t=makeDeviceTask(p.session,{pageId,senderId,requestId,goal:'Work'},now+3);const a=acceptDeviceTask(p.session,p.deviceKey,t,{approvedGoalHash:t.goalHash},now+4);
 const revoked=revokeDeviceSession(p.session,p.deviceKey,now+5);assert.equal(revoked.deviceKeyHash,null);
 assert.throws(()=>makeDeviceTask(revoked,{pageId,senderId,requestId,goal:'Work'},now+6));
 assert.throws(()=>finishDeviceTask(revoked,p.deviceKey,a.task,{lease:a.lease,result:{summary:'x',verification:'x',files:[]}},now+6));
 assert.equal(cancelDeviceTask(a.task,revoked,now+6).state,'cancelled');
 assert.throws(()=>acceptDeviceTask(p.session,p.deviceKey,t,{approvedGoalHash:t.goalHash},p.session.expiresAt));
});
test('pairing code is not a device credential, and local refusal cannot be changed to acceptance',()=>{
 const p=paired();const t=makeDeviceTask(p.session,{pageId,senderId,requestId,goal:'Work'},now+3);
 assert.throws(()=>acceptDeviceTask(p.session,p.pairingCode,t,{approvedGoalHash:t.goalHash},now+4));
 const denied=rejectDeviceTask(p.session,p.deviceKey,t,now+4);assert.equal(denied.state,'declined');
 assert.throws(()=>acceptDeviceTask(p.session,p.deviceKey,denied,{approvedGoalHash:t.goalHash},now+5));
 const revoked=revokeDeviceSession(p.session,p.deviceKey,now+6);assert.deepEqual(cancelDeviceTask(denied,revoked,now+7),denied);
});
test('device-first enrollment keeps local credential off Messenger and binds once through signed Page identity',()=>{
 const local=createDeviceSession({pageId},now);assert.equal(local.session.senderId,null);
 assert.throws(()=>makeDeviceTask(local.session,{pageId,senderId,requestId,goal:'x'},now+1));
 const bound=confirmPageBinding(local.session,{pageId,senderId,pairingCode:local.pairingCode},now+1);
 assert.equal(bound.senderId,senderId);assert.equal(bound.state,'pending_owner');
 assert.throws(()=>confirmPageBinding(bound,{pageId,senderId:'67890',pairingCode:local.pairingCode},now+2));
 assert.equal(confirmLocalOwner(bound,local.deviceKey,{attended:true,workspaceLabel:'Shop'},now+2).state,'active');
});
