import {readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export async function collectOutputs(dir,names){
 if(!Array.isArray(names)||names.length>8||new Set(names).size!==names.length)throw Error('Invalid exported names');
 const receipts=[];
 for(const file of await readdir(dir))if(/^receipt-\d{1,2}\.json$/.test(file)){
  const s=await lstat(join(dir,file));if(!s.isFile()||s.isSymbolicLink()||s.size>30000)throw Error('Invalid receipt');
  receipts.push(...JSON.parse(await readFile(join(dir,file),'utf8')));
 }
 let total=0;const out=[];
 for(const name of names){
  if(typeof name!=='string'||!name.length||name.includes('..')||!/^[\p{L}\p{N} _().-]{1,120}$/u.test(name)||name.startsWith('.'))throw Error('Invalid artifact name');
  const matches=receipts.filter(r=>r.name===name);
  const hashes=new Set(matches.map(r=>r.sha256));
  if(!matches.length||hashes.size!==1)throw Error('Artifact not generated or ambiguous');
  const r=matches[0];if(!/^\d{1,2}-[a-f0-9]{64}$/.test(r.stored))throw Error('Invalid stored object');
  const path=join(dir,r.stored),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>5_000_000)throw Error('Invalid stored bytes');
  const bytes=await readFile(path);total+=bytes.length;
  if(total>10_000_000||bytes.length!==r.bytes||createHash('sha256').update(bytes).digest('hex')!==r.sha256)throw Error('Artifact integrity failed');
  out.push({name,mime:'application/octet-stream',bytes,sha256:r.sha256});
 }
 return out;
}
