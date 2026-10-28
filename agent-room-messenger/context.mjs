import {createHash} from 'node:crypto';
import {prepareInputs,inputMetadata} from './inputs.mjs';

export async function conversationSchema(pool){await pool.query(`CREATE TABLE IF NOT EXISTS messenger_outgoing_context(source_id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,message_text TEXT NOT NULL,attachment_types JSONB NOT NULL,source_timestamp BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()); CREATE INDEX IF NOT EXISTS messenger_outgoing_context_sender ON messenger_outgoing_context(sender_id,created_at);`);}
export async function conversationHistory(pool,job){
 return (await pool.query(`SELECT * FROM (SELECT message_text AS customer,reply_text AS assistant,created_at AS at,NULL::JSONB AS page_attachment_types FROM messenger_requests WHERE sender_id=$1 AND id<>$2 AND created_at<$3 AND provider_id IS NOT NULL UNION ALL SELECT NULL AS customer,e.message_text AS assistant,e.created_at AS at,e.attachment_types AS page_attachment_types FROM messenger_outgoing_context e WHERE e.sender_id=$1 AND e.created_at<$3 AND NOT EXISTS(SELECT 1 FROM messenger_requests r WHERE r.sender_id=$1 AND r.provider_id=e.source_id)) AS scoped_history ORDER BY at`,[job.sender_id,job.id,job.created_at])).rows;
}

export async function prepareJobInputs(pool,job,options={}){
 // A new upload is always authoritative for this request. Never substitute an
 // older file when the new upload is unavailable or rejected by the broker.
 if(job.attachment_types?.length)return prepareInputs(pool,job,options);
 const args=[job.sender_id,job.id,job.created_at];
 let files=(await pool.query(`SELECT a.name,a.mime,a.bytes,a.sha256,a.request_id,r.created_at AS source_created_at,r.status AS source_status FROM messenger_artifacts a JOIN messenger_requests r ON r.id=a.request_id WHERE a.sender_id=$1 AND r.sender_id=$1 AND r.id<>$2 AND r.created_at<$3 AND a.expires_at>NOW() AND r.provider_id IS NOT NULL AND a.request_id=(SELECT r2.id FROM messenger_requests r2 WHERE r2.sender_id=$1 AND r2.id<>$2 AND r2.created_at<$3 AND r2.provider_id IS NOT NULL AND EXISTS(SELECT 1 FROM messenger_artifacts a2 WHERE a2.request_id=r2.id AND a2.sender_id=$1 AND a2.expires_at>NOW()) ORDER BY r2.created_at DESC LIMIT 1) ORDER BY a.name LIMIT 9`,args)).rows;
 let origin='previous_output';
 const outputs=files;
 const inputs=(await pool.query(`SELECT a.name,a.mime,a.bytes,a.sha256,a.request_id,r.created_at AS source_created_at,r.status AS source_status FROM messenger_inputs a JOIN messenger_requests r ON r.id=a.request_id WHERE a.sender_id=$1 AND r.sender_id=$1 AND r.id<>$2 AND r.created_at<$3 AND a.expires_at>NOW() AND a.request_id=(SELECT r2.id FROM messenger_requests r2 WHERE r2.sender_id=$1 AND r2.id<>$2 AND r2.created_at<$3 AND EXISTS(SELECT 1 FROM messenger_inputs a2 WHERE a2.request_id=r2.id AND a2.sender_id=$1 AND a2.expires_at>NOW()) ORDER BY r2.created_at DESC LIMIT 1) ORDER BY a.name LIMIT 9`,args)).rows;
 const sourceTime=set=>{if(!set.length)return -Infinity;const time=new Date(set[0].source_created_at).valueOf();if(!Number.isFinite(time))throw Error('Invalid context timestamp');return time;};
 if(inputs.length&&sourceTime(inputs)>sourceTime(outputs)){files=inputs;origin='previous_input';}
 if(files.length>8||files.reduce((n,f)=>n+(f.bytes?.length||0),0)>10_000_000)throw Error('Conversation input transport limit');
 const scoped={};const metadata=[];
 for(const [i,f] of files.entries()){
  if(typeof f.name!=='string'||f.name.startsWith('.')||f.name.includes('..')||!/^[\p{L}\p{N} _().-]{1,120}$/u.test(f.name)||!Buffer.isBuffer(f.bytes)||f.bytes.length>5_000_000||createHash('sha256').update(f.bytes).digest('hex')!==f.sha256)throw Error('Conversation file integrity failed');
  const name=`previous-${origin==='previous_output'?'output':'input'}-${i+1}-${Array.from(f.name).slice(0,80).join('')}`;
  scoped['/input/'+name]=f.bytes.toString('base64');
  metadata.push({...inputMetadata({...f,name}),origin,originalName:f.name,sourceRequestId:f.request_id,sourceCreatedAt:f.source_created_at,sourceStatus:f.source_status});
 }
 return {files:scoped,metadata};
}
