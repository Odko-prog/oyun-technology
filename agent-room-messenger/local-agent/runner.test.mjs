import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {codexInvocation,runAttendedTask,startOwnedProcess} from './runner.mjs';
const goal='Read supplied shop files; $(not-a-shell-command) --dangerously-bypass-approvals-and-sandbox';
const task={state:'awaiting_owner',requestId:'fixture',goal,goalHash:createHash('sha256').update(goal).digest('hex')};
const acceptTask=async()=>({state:'running',goalHash:task.goalHash,lease:'a'.repeat(64)});
const authenticate=async()=>true;
test('local invocation has explicit workspace approvals and passes untrusted goal as one positional argument',()=>{
 const r=codexInvocation(goal,'C:\\owned workspace');assert.equal(r.options.shell,false);assert.equal(r.args.at(-1),goal);assert.equal(r.args.at(-2),'--');assert.equal(r.options.env.OPENAI_API_KEY,undefined);assert.equal(r.options.env.CODEX_API_KEY,undefined);assert.ok(r.args.includes('workspace-write'));assert.ok(r.args.includes('approvals_reviewer=user'));
});
test('owner refusal or revocation during approval never launches Codex',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-room-local-'));let launched=0;
 try{
  const launch=()=>{launched++;throw Error('must not launch');};
  assert.equal((await runAttendedTask({task,workspace:root,askOwner:async()=>null,isSessionActive:async()=>true,launch})).state,'declined');
  let active=true;assert.equal((await runAttendedTask({task,workspace:root,askOwner:async()=>{active=false;return {approvedGoalHash:task.goalHash};},isSessionActive:async()=>active,launch})).state,'stopped');assert.equal(launched,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('revocation stops an actual owned child process; zero exit is never called delivered',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-room-process-'));let active=true;let pid;
 try{
  const launch=()=>{const child=startOwnedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:root,shell:false,stdio:'ignore',windowsHide:true});pid=child.pid;setTimeout(()=>{active=false;},150);return child;};
  const result=await runAttendedTask({task,workspace:root,askOwner:async()=>({approvedGoalHash:task.goalHash}),isSessionActive:async()=>active,acceptTask,authenticate,launch,pollMs:30});
  assert.equal(result.state,'stopped');assert.throws(()=>process.kill(pid,0));
  const done=await runAttendedTask({task,workspace:root,askOwner:async()=>({approvedGoalHash:task.goalHash}),isSessionActive:async()=>true,acceptTask,authenticate,launch:()=>startOwnedProcess(process.execPath,['-e','process.exit(0)'],{cwd:root,shell:false,stdio:'ignore',windowsHide:true})});assert.equal(done.state,'awaiting_result_review');assert.equal(done.exitCode,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('auth or server lease failure prevents local execution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-room-no-launch-'));let launched=0;
 try{
  const options={task,workspace:root,askOwner:async()=>({approvedGoalHash:task.goalHash}),isSessionActive:async()=>true,launch:()=>{launched++;throw Error('must not launch');}};
  await assert.rejects(runAttendedTask({...options,acceptTask,authenticate:async()=>{throw Error('Auth unavailable');}}),/Auth unavailable/);
  await assert.rejects(runAttendedTask({...options,authenticate,acceptTask:async()=>({state:'running',goalHash:'wrong',lease:'a'.repeat(64)})}),/lease not verified/);assert.equal(launched,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Windows revoke terminates an owned process and its spawned descendant',{skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-room-tree-')),pidFile=join(root,'owned-process.json');let parent,descendant;
 try{
  const script='const {spawn}=require("node:child_process");const fs=require("node:fs");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});fs.writeFileSync(process.argv[1],JSON.stringify({pid:c.pid}));setInterval(()=>{},1000);';
  const result=await runAttendedTask({task,workspace:root,askOwner:async()=>({approvedGoalHash:task.goalHash}),authenticate,acceptTask,pollMs:30,isSessionActive:async()=>{try{descendant=JSON.parse(await readFile(pidFile,'utf8')).pid;return false;}catch{return true;}},launch:()=>{parent=startOwnedProcess(process.execPath,['-e',script,pidFile],{cwd:root,shell:false,stdio:'ignore',windowsHide:true});return parent;}});
  assert.equal(result.state,'stopped');assert.ok(Number.isInteger(descendant));assert.throws(()=>process.kill(parent.pid,0));assert.throws(()=>process.kill(descendant,0));
 }finally{await parent?.stop();await rm(root,{recursive:true,force:true});}
});
