import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {runLocalAgent} from './cli.mjs';
import {runAttendedTask,startOwnedProcess} from './runner.mjs';
import {decodeDeviceArtifacts} from '../device-tasks.mjs';
test('foreground client links owner approval, actual local output collection and acknowledged result without public access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-room-cli-')),abort=new AbortController();const goal='Produce the requested fixture CSV';
 const task={id:'12345678-0000-4000-8000-123456789012',requestId:'12345678-0000-4000-8000-123456789013',goal,goalHash:createHash('sha256').update(goal).digest('hex'),state:'awaiting_owner',expiresAt:Date.now()+60000};
 const replies=['yes','yes','yes','Verified fixture output','Actual CSV bytes checked','result.csv','yes'];let active=false,submitted=false,revoked=false,accepted=0,payload;const messages=[];
 const connection={pairingMessage:'AGENT-CONNECT fixture-not-a-real-code',status:async()=>({state:active?'active':'pending_owner'}),activate:async b=>{assert.equal(b.confirmed,true);active=true;},tasks:async()=>[task],acceptTask:async b=>{assert.equal(b.approvedGoalHash,task.goalHash);accepted++;return {state:'running',goalHash:task.goalHash,lease:'a'.repeat(64)};},declineTask:async()=>{throw Error('unexpected decline');},taskStatus:async()=>{if(submitted){abort.abort();return {state:'delivered',delivered:true,deliveryState:'sent'};}return {state:'running',delivered:false};},submitResult:async(id,b)=>{assert.equal(id,task.id);payload=b;const files=decodeDeviceArtifacts(b.files);assert.equal(files[0].bytes.toString(),'item,total\napples,91\n');submitted=true;return {state:'result_ready'};},revoke:async()=>{revoked=true;return {state:'revoked'};}};
 try{
  const result=await runLocalAgent({workspace:root,signal:abort.signal,ask:async()=>{assert.ok(replies.length);return replies.shift();},write:s=>messages.push(s),connect:async()=>connection,authenticate:async()=>true,run:options=>runAttendedTask({...options,pollMs:30,launch:()=>startOwnedProcess(process.execPath,['-e','require("node:fs").writeFileSync(process.argv[1],"item,total\\napples,91\\n")',join(root,'outputs','result.csv')],{cwd:root,shell:false,stdio:'ignore',windowsHide:true})})});
  assert.equal(result.state,'stopped');assert.equal(accepted,1);assert.equal(revoked,true);assert.equal(replies.length,0);assert.equal(payload.files.length,1);assert.ok(messages.some(x=>x.includes('хараахан батлагдаагүй')));assert.ok(messages.some(x=>x.includes('хүлээн авсан нь батлагдлаа')));
 }finally{await rm(root,{recursive:true,force:true});}
});
