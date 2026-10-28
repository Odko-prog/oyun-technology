import {realpath,lstat,open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export async function collectLocalResult(workspace,{summary,verification,names}){
 if(typeof summary!=='string'||!summary.trim()||summary.length>1800||typeof verification!=='string'||!verification.trim()||verification.length>4000||!Array.isArray(names)||names.length>8||new Set(names).size!==names.length)throw Error('Invalid selected result');
 const root=await realpath(workspace),output=join(root,'outputs');const dir=await lstat(output);
 if(!dir.isDirectory()||dir.isSymbolicLink()||await realpath(output)!==output)throw Error('Output directory is not local');
 const files=[];let total=0;
 for(const name of names){
  if(typeof name!=='string'||!/^[\p{L}\p{N} _().-]{1,120}$/u.test(name)||name.startsWith('.')||name.includes('..')||/^(auth\.json|credentials?\.json|id_rsa|id_ed25519|.*\.(key|pem|pfx|p12))$/i.test(name))throw Error('Choose only intended deliverables, not credentials or paths');
  const path=join(output,name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>5_000_000||await realpath(path)!==path)throw Error('Unsafe result file');
  const handle=await open(path,'r');let bytes;
  try{
   const opened=await handle.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.nlink!==1||opened.size!==stat.size)throw Error('Result file changed');
   const chunks=[];let size=0;
   for(;;){const chunk=Buffer.alloc(65536);const r=await handle.read(chunk,0,chunk.length,size);if(!r.bytesRead)break;size+=r.bytesRead;if(size>stat.size||size>5_000_000)throw Error('Result grew during collection');chunks.push(chunk.subarray(0,r.bytesRead));}
   bytes=Buffer.concat(chunks);const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||bytes.length!==stat.size)throw Error('Result changed during collection');
  }finally{await handle.close();}
  total+=bytes.length;if(total>10_000_000)throw Error('Selected result transport limit');
  files.push({name,mime:'application/octet-stream',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});
 }
 return {summary:summary.trim(),verification:verification.trim(),files};
}
