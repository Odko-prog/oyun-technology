import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,lstat,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
export async function verifyChatGPTLogin(){
 const env={...process.env};delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;
 try{const r=await promisify(execFile)('codex.exe',['login','status'],{env,shell:false,windowsHide:true,timeout:10000,maxBuffer:8192});if(/Logged in using ChatGPT/i.test(r.stdout+'\n'+r.stderr))return true;}catch{}
 throw Error('Sign in to your own Codex with ChatGPT before accepting a task');
}
export async function prepareWorkspace(path){
 const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Choose a real local workspace directory');
 const root=await realpath(path);
 for(const name of ['inputs','outputs']){const target=join(root,name);await mkdir(target,{recursive:true});const entry=await lstat(target);if(!entry.isDirectory()||entry.isSymbolicLink()||await realpath(target)!==target)throw Error('Workspace child must be a real local directory');}
 return root;
}
export function codexInvocation(goal,workspace){
 if(typeof goal!=='string'||!goal.trim()||goal.length>12000)throw Error('Invalid local goal');
 const env={...process.env};delete env.OPENAI_API_KEY;delete env.CODEX_API_KEY;
 return {command:'codex.exe',args:['--no-daemon','--search','--sandbox','workspace-write','--ask-for-approval','on-request','-c','approvals_reviewer=user','--cd',workspace,'--',goal],options:{cwd:workspace,env,shell:false,stdio:'inherit',windowsHide:false}};
}
export function startOwnedProcess(command,args,options){
 const child=spawn(command,args,options);
 let ended=false;const completion=new Promise((ok,no)=>{child.once('error',error=>{ended=true;no(error);});child.once('close',(code,signal)=>{ended=true;ok({code,signal});});});
 // Mark handled immediately while the caller awaits approval/polling cleanup.
 completion.catch(()=>{});
 let stopPromise;
 const stop=()=>stopPromise??=new Promise((ok,no)=>{
  if(ended||!child.pid){ok();return;}
  if(process.platform!=='win32'){child.kill('SIGTERM');completion.then(ok,no);return;}
  const killer=spawn(join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{shell:false,stdio:'ignore',windowsHide:true});
  killer.once('error',no);killer.once('close',code=>{if(code!==0&&!ended){no(Error('Owned process tree stop was not confirmed'));return;}completion.then(ok,no);});
 });
 return {completion,stop,get pid(){return child.pid;}};
}
export async function runAttendedTask({task,workspace,askOwner,isSessionActive,acceptTask,authenticate=verifyChatGPTLogin,launch=startOwnedProcess,signal,pollMs=5000}){
 task={...task};
 if(!task||task.state!=='awaiting_owner'||typeof task.goal!=='string'||hash(task.goal)!==task.goalHash)throw Error('Unverified local task');
 const root=await prepareWorkspace(workspace);
 if(signal?.aborted||!await isSessionActive())return {state:'stopped',started:false};
 const choice=await askOwner({requestId:task.requestId,goal:task.goal,goalHash:task.goalHash,workspace:root});
 if(choice?.approvedGoalHash!==task.goalHash)return {state:'declined',started:false};
 // Recheck after the human step. Never run a task on a stale or revoked session.
 if(signal?.aborted||!await isSessionActive())return {state:'stopped',started:false};
 await authenticate();
 if(typeof acceptTask!=='function')throw Error('Server task lease adapter required');
 const grant=await acceptTask({id:task.id,approvedGoalHash:task.goalHash});
 if(grant?.state!=='running'||grant.goalHash!==task.goalHash||typeof grant.lease!=='string'||!/^[a-f0-9]{64}$/.test(grant.lease))throw Error('Server task lease not verified');
 if(signal?.aborted||!await isSessionActive())return {state:'stopped',started:false,lease:grant.lease};
 const invocation=codexInvocation(task.goal,root);const process=launch(invocation.command,invocation.args,invocation.options);
 let stopping=false,checking=false,stopWork;
 let rejectStop;const stopFailure=new Promise((_,no)=>{rejectStop=no;});stopFailure.catch(()=>{});
 const stop=()=>stopWork??=(async()=>{stopping=true;try{await process.stop();}catch(e){rejectStop(e);throw e;}})();
 const onAbort=()=>{void stop().catch(()=>{});};signal?.addEventListener('abort',onAbort,{once:true});
 if(signal?.aborted)onAbort();
 const timer=setInterval(async()=>{if(checking||stopping)return;checking=true;try{if(!await isSessionActive())await stop();}catch{await stop().catch(()=>{});}finally{checking=false;}},pollMs);
 try{
  const exit=await Promise.race([process.completion,stopFailure]);if(stopWork)await stopWork;
  // A successful CLI exit is not evidence of completed work or delivery.
  return {state:stopping?'stopped':'awaiting_result_review',started:true,exitCode:exit.code,lease:grant.lease};
 }finally{clearInterval(timer);signal?.removeEventListener('abort',onAbort);}
}
