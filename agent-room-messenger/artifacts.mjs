import {randomBytes,createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
export async function artifactSchema(pool){await pool.query(`CREATE TABLE IF NOT EXISTS messenger_artifacts(token_hash TEXT PRIMARY KEY,request_id UUID NOT NULL REFERENCES messenger_requests(id),sender_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,bytes BYTEA NOT NULL,sha256 TEXT NOT NULL,expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours'); CREATE INDEX IF NOT EXISTS messenger_artifacts_expiry ON messenger_artifacts(expires_at); ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS cloud_task_id TEXT;`);}
export async function saveArtifacts(pool,job,artifacts,{origin='https://agent-room-messenger-ingress.onrender.com',random=()=>randomBytes(32).toString('hex')}={}){
 if(!/^https:\/\/[a-z0-9.-]+$/.test(origin))throw Error('Invalid artifact origin');
 const links=[];
 if(!Array.isArray(artifacts)||artifacts.length>8)throw Error('Artifact count limit');
 let total=0;
 for(const file of artifacts){
  if(typeof file.name!=='string'||!file.name.length||file.name.startsWith('.')||file.name.includes('..')||!/^[\p{L}\p{N} _().-]{1,120}$/u.test(file.name)||typeof file.mime!=='string'||!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mime))throw Error('Invalid artifact metadata');
  if(!Buffer.isBuffer(file.bytes)||file.bytes.length>5_000_000||!file.bytes.length||file.sha256!==hash(file.bytes))throw Error('Artifact integrity check failed');
  total+=file.bytes.length;if(total>10_000_000)throw Error('Artifact size limit');
  const token=random();if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid capability token');
  await pool.query('INSERT INTO messenger_artifacts(token_hash,request_id,sender_id,name,mime,bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[hash(token),job.id,job.sender_id,file.name,file.mime,file.bytes,file.sha256]);
  links.push({name:file.name,url:origin+'/artifact/'+token,sha256:file.sha256});
 }
 // Delete expired output data, not conversation history. URLs are never emitted in logs.
 await pool.query('DELETE FROM messenger_artifacts WHERE expires_at<NOW()');return links;
}
export function composeDelivery(reply,links){
 if(!links.length)return reply;
 const files=links.map((a,i)=>`${i+1}. ${a.name.slice(0,32)}\n${a.url}`).join('\n');
 const room=1800-files.length-65;if(room<40)throw Error('Too many artifact links for Messenger');
 const summary=reply.length<=room?reply:'Ажлын үр дүнгийн файлууд бэлэн боллоо.';
 return `${summary}\n\n${files}\n\nТатах холбоос 24 цаг хүчинтэй.`;
}
export async function serveArtifact(path,res,pool){
 if(!path.startsWith('/artifact/'))return false;
 const token=path.slice('/artifact/'.length);const deny=()=>{res.writeHead(404,{'Cache-Control':'no-store'});res.end('Not found');return true;};
 if(!/^[a-f0-9]{64}$/.test(token))return deny();
 const rows=await pool.query('SELECT name,mime,bytes,sha256 FROM messenger_artifacts WHERE token_hash=$1 AND expires_at>NOW()',[hash(token)]);
 const f=rows.rows[0];if(!f||hash(f.bytes)!==f.sha256)return deny();
 const name=encodeURIComponent(f.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16));
 res.writeHead(200,{'Content-Type':f.mime,'Content-Length':f.bytes.length,'Content-Disposition':`attachment; filename="result"; filename*=UTF-8''${name}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Referrer-Policy':'no-referrer'});res.end(f.bytes);return true;
}
