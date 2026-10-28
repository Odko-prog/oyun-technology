import {request as httpsRequest} from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';

export function metaAttachmentURL(value){
 if(typeof value!=='string'||value.length>8192)throw Error('Invalid attachment reference');
 const u=new URL(value),h=u.hostname.toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!['fbcdn.net','fbsbx.com'].some(root=>h===root||h.endsWith('.'+root)))throw Error('Attachment host not allowed');
 return u;
}
export function publicIPv4(address){
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===0||b===168||(b===88&&c===99)))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
export async function downloadAttachment(reference,{lookup=dnsLookup,request=httpsRequest,signal,maxBytes=5_000_000,redirects=0}={}){
 const u=metaAttachmentURL(reference);
 if(redirects>2)throw Error('Attachment redirect limit');
 let dnsTimer;
 const addresses=await Promise.race([lookup(u.hostname,{family:4,all:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('Attachment DNS timeout')),5000);})]).finally(()=>clearTimeout(dnsTimer));
 if(!addresses.length||addresses.some(a=>!publicIPv4(a.address)))throw Error('Attachment address not public');
 const address=addresses[0].address;
 const result=await new Promise((resolve,reject)=>{
  const req=request(u,{agent:false,family:4,autoSelectFamily:false,signal,headers:{'Accept-Encoding':'identity','User-Agent':'AgentRoom-SubmittedFile/1.0'},lookup:(host,opts,cb)=>{
   if(host!==u.hostname)return cb(Error('Unexpected hostname'));
   opts?.all?cb(null,[{address,family:4}]):cb(null,address,4);
  }},res=>{
   res.on('error',()=>reject(Error('Attachment response failed')));
   res.once('aborted',()=>reject(Error('Attachment response aborted')));
   if([301,302,303,307,308].includes(res.statusCode)){
    const location=res.headers.location;res.destroy();
    try{if(typeof location!=='string')throw Error();resolve({redirect:metaAttachmentURL(new URL(location,u).href).href});}catch{reject(Error('Attachment redirect rejected'));}return;
   }
   if(res.statusCode!==200||(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')||Number(res.headers['content-length']||0)>maxBytes){res.destroy();reject(Error('Attachment response rejected'));return;}
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(Error('Attachment size limit'));}else chunks.push(chunk);});
   res.on('end',()=>resolve({bytes:Buffer.concat(chunks),mime:String(res.headers['content-type']||'application/octet-stream').split(';')[0].slice(0,100).toLowerCase()}));
  });
  req.on('error',()=>reject(Error('Attachment download failed')));
  req.setTimeout(10000,()=>req.destroy(Error('Attachment timeout')));
  const timer=setTimeout(()=>req.destroy(Error('Attachment deadline')),15000);
  req.once('close',()=>clearTimeout(timer));req.end();
 });
 if(result.redirect)return downloadAttachment(result.redirect,{lookup,request,signal,maxBytes,redirects:redirects+1});
 if(!result.bytes.length)throw Error('Empty attachment');return result;
}
export async function inputSchema(pool){await pool.query(`ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS attachment_refs JSONB NOT NULL DEFAULT '[]'; CREATE TABLE IF NOT EXISTS messenger_inputs(request_id UUID NOT NULL REFERENCES messenger_requests(id),sender_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,bytes BYTEA NOT NULL,sha256 TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours',PRIMARY KEY(request_id,name));`);}
export function inputMetadata(file){
 let text=null;
 if(file.bytes.length<=1_000_000)try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);if(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded))text=decoded.slice(0,24000);}catch{}
 return {name:file.name,mime:file.mime,bytes:file.bytes.length,sha256:file.sha256,textPreview:text,previewTruncated:text!==null&&Buffer.byteLength(text)<file.bytes.length};
}
export async function prepareInputs(pool,job,{download=downloadAttachment,signal}={}){
 const deadline=AbortSignal.timeout(60000);const boundedSignal=signal?AbortSignal.any([signal,deadline]):deadline;
 let files=(await pool.query('SELECT name,mime,bytes,sha256 FROM messenger_inputs WHERE request_id=$1 AND sender_id=$2 AND expires_at>NOW() ORDER BY name',[job.id,job.sender_id])).rows;
 const refs=Array.isArray(job.attachment_refs)?job.attachment_refs:[];
 if(!files.length&&refs.length){
  if(refs.length>8)throw Error('Input file count limit');
  const downloaded=[];let total=0;
  for(const [i,ref] of refs.entries()){
   if(boundedSignal.aborted)throw Error('Input preparation deadline');
   const f=await download(ref.url,{signal:boundedSignal});total+=f.bytes.length;if(total>10_000_000)throw Error('Input size limit');
   const extension=({'text/csv':'csv','application/json':'json','application/pdf':'pdf','image/png':'png','image/jpeg':'jpg','text/plain':'txt'})[f.mime]||'bin';
   downloaded.push({...f,name:`attachment-${i+1}.${extension}`,sha256:createHash('sha256').update(f.bytes).digest('hex')});
  }
  // One PostgreSQL statement persists the complete set and removes expiring URLs.
  // A crash cannot expose a partly persisted input set on the next worker run.
  await pool.query(`WITH inserted AS (INSERT INTO messenger_inputs(request_id,sender_id,name,mime,bytes,sha256) SELECT $1,$2,x.name,x.mime,decode(x.base64,'base64'),x.sha256 FROM jsonb_to_recordset($3::jsonb) AS x(name TEXT,mime TEXT,base64 TEXT,sha256 TEXT) ON CONFLICT(request_id,name) DO NOTHING RETURNING request_id) UPDATE messenger_requests SET attachment_refs='[]' WHERE id=$1 AND sender_id=$2 AND (SELECT COUNT(*) FROM inserted)>=0`,[job.id,job.sender_id,JSON.stringify(downloaded.map(f=>({name:f.name,mime:f.mime,base64:f.bytes.toString('base64'),sha256:f.sha256})))]);
  files=downloaded;
 }
 if(files.length>8||files.reduce((n,f)=>n+(f.bytes?.length||0),0)>10_000_000)throw Error('Input storage limit');
 for(const f of files)if(!Buffer.isBuffer(f.bytes)||f.bytes.length>5_000_000||f.sha256!==createHash('sha256').update(f.bytes).digest('hex'))throw Error('Input integrity failed');
 await pool.query('DELETE FROM messenger_inputs WHERE expires_at<NOW()');
 return {files:Object.fromEntries(files.map(f=>['/input/'+f.name,f.bytes.toString('base64')])),metadata:files.map(inputMetadata)};
}
