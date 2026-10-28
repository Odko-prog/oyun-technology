import {createHmac,timingSafeEqual} from 'node:crypto';
import {metaAttachmentURL} from './inputs.mjs';
export function sameSecret(a,b){if(typeof a!=='string'||typeof b!=='string'||!a||!b)return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}
export function validSignature(raw,signature,secret){if(!secret||!/^sha256=[a-f0-9]{64}$/i.test(signature||''))return false;return sameSecret(signature.toLowerCase(),'sha256='+createHmac('sha256',secret).update(raw).digest('hex'))}
export function extractEvents(body,pageId){
 if(body?.object!=='page'||!Array.isArray(body.entry))throw Error('Unsupported event');
 const events=[];
 for(const entry of body.entry){if(String(entry?.id)!==pageId)continue;
  for(const e of Array.isArray(entry.messaging)?entry.messaging:[]){
   const m=e?.message;
   if(!m||m.is_echo||typeof m.mid!=='string'||m.mid.length>200||!m.mid||String(e.recipient?.id)!==pageId||!/^\d{1,30}$/.test(String(e.sender?.id)))continue;
   const text=typeof m.text==='string'?m.text.slice(0,6000):'';
   const attachments=Array.isArray(m.attachments)?m.attachments.slice(0,10).map(a=>String(a?.type||'unknown').slice(0,40)):[];
   if(!text&&!attachments.length)continue;
   // This extractor is called only after webhook HMAC validation. No network IO
   // occurs here; only signed-event Meta CDN references reach the input broker.
   const attachmentRefs=[];
   for(const a of Array.isArray(m.attachments)?m.attachments.slice(0,8):[]){
    if(!['image','file','audio','video'].includes(a?.type))continue;
    try{attachmentRefs.push({type:a.type,url:metaAttachmentURL(a.payload?.url).href});}catch{}
   }
   events.push({sourceId:m.mid,senderId:String(e.sender.id),text,attachments,attachmentRefs,timestamp:Number.isFinite(e.timestamp)?e.timestamp:null});
  }
 }
 return events;
}

export function extractOutgoingEvents(body,pageId){
 if(body?.object!=='page'||!Array.isArray(body.entry))throw Error('Unsupported event');
 const events=[];
 for(const entry of body.entry){
  if(String(entry?.id)!==pageId)continue;
  for(const e of Array.isArray(entry.messaging)?entry.messaging:[]){
   const m=e?.message,customer=String(e.recipient?.id);
   if(m?.is_echo!==true||String(e.sender?.id)!==pageId||customer===pageId||!/^\d{1,30}$/.test(customer)||typeof m.mid!=='string'||!m.mid||m.mid.length>200)continue;
   const text=typeof m.text==='string'?m.text.slice(0,6000):'';
   const attachments=Array.isArray(m.attachments)?m.attachments.slice(0,10).map(a=>String(a?.type||'unknown').slice(0,40)):[];
   if(text||attachments.length)events.push({sourceId:m.mid,senderId:customer,text,attachments,timestamp:Number.isFinite(e.timestamp)?e.timestamp:null});
  }
 }
 return events;
}
