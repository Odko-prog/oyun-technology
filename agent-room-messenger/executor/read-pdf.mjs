import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),script=fileURLToPath(new URL('./read-pdf-child.mjs',import.meta.url));
export async function readPdf(bytes,{signal}={}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>5_000_000)throw Error('PDF size limit');
 const moduleRoot=dirname(require.resolve('pdfjs-dist/package.json'));
 const permissionFlag=['--permission','--experimental-permission'].find(flag=>process.allowedNodeEnvironmentFlags.has(flag));
 if(!permissionFlag)throw Error('PDF parser requires Node permission support');
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--max-old-space-size=96',permissionFlag,`--allow-fs-read=${dirname(script)}`,`--allow-fs-read=${moduleRoot}`,script,pathToFileURL(join(moduleRoot,'legacy/build/pdf.mjs')).href],{env:{PATH:process.env.PATH||'',LANG:'C.UTF-8'},stdio:['pipe','pipe','ignore'],signal});
  let output='',reason=null,done=false;
  const kill=why=>{reason=why;child.kill('SIGKILL');};const timer=setTimeout(()=>kill('PDF parser timeout'),15000);
  const monitor=process.platform==='linux'?setInterval(async()=>{try{const s=await readFile(`/proc/${child.pid}/status`,'utf8');if(Number(s.match(/^VmRSS:\s+(\d+)/m)?.[1]||0)>192*1024)kill('PDF parser memory limit');}catch{}},50):null;
  const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);if(monitor)clearInterval(monitor);error?reject(error):resolve(result);};
  child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>3_200_000)kill('PDF output limit');});
  child.once('error',()=>finish(Error('PDF parser process unavailable')));
  child.once('close',code=>{if(reason)return finish(Error(reason));try{const value=JSON.parse(output);if(code!==0||!value.ok)throw Error('PDF text unavailable or parser limit reached');finish(null,value);}catch{finish(Error('PDF text unavailable or parser limit reached'));}});
  child.stdin.on('error',()=>{});child.stdin.end(bytes.toString('base64'));
 });
}

