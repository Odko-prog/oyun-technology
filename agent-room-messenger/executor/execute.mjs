import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./execute-child.mjs',import.meta.url));
export async function executeCode(input,{signal,rssLimitMiB=input.runtime==='quickjs'?192:320}={}){
 if(Buffer.byteLength(JSON.stringify(input))>2_000_000)throw Error('Input transport limit');
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[`--max-old-space-size=${input.runtime==='quickjs'?96:192}`,script],{
   env:{PATH:process.env.PATH||'',LANG:'C.UTF-8'},stdio:['pipe','pipe','ignore'],signal});
  let output='',finished=false,reason=null;
  const stop=why=>{reason=why;child.kill('SIGKILL');};
  const deadline=setTimeout(()=>stop('timeout'),25000);
  // Linux process RSS includes this process's WASI worker threads. The platform
  // cgroup remains the final ceiling; this watchdog is not a hard memory quota.
  const monitor=process.platform==='linux'?setInterval(async()=>{
   try{const s=await readFile(`/proc/${child.pid}/status`,'utf8');const kb=Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1]||0);if(kb>rssLimitMiB*1024)stop('resource_limit');}catch{}
  },50):null;
  const finish=(err,result)=>{if(finished)return;finished=true;clearTimeout(deadline);if(monitor)clearInterval(monitor);err?reject(err):resolve(result);};
  child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>14_000_000)stop('output_limit');});
  child.once('error',()=>finish(Error('Execution process unavailable')));
  child.once('close',code=>{
   if(reason)return finish(null,{type:reason,artifacts:[]});
   if(code!==0)return finish(null,{type:'crash',artifacts:[]});
   try{finish(null,JSON.parse(output));}catch{finish(Error('Invalid executor response'));}
  });
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
 });
}
