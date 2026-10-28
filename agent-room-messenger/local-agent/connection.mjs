const ORIGIN='https://agent-room-messenger-ingress.onrender.com';
const PAGE='1309261702280978';
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
async function jsonResponse(response){
 if(!response.ok){await response.body?.cancel();throw Error('Device service unavailable or authorization rejected');}
 if(!/^application\/json\b/i.test(response.headers.get('content-type')||''))throw Error('Unexpected device service response');
 let size=0;const chunks=[];
 for await(const chunk of response.body){size+=chunk.length;if(size>262144)throw Error('Device response size limit');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('Invalid device service response');}
}
export async function openLocalConnection({label='Local agent',fetchImpl=fetch,now=Date.now}={}){
 if(typeof label!=='string'||!label.trim()||label.length>80)throw Error('Invalid local device label');
 let key=null,closed=false;
 const request=async(path,method='GET',body)=>{
  if(closed)throw Error('Local device connection closed');
  const headers={'Content-Type':'application/json'};if(key)headers.Authorization='Bearer '+key;
  try{return await jsonResponse(await fetchImpl(ORIGIN+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(10000)}));}
  catch{throw Error('Device connection unavailable; do not start or continue remote work');}
 };
 const start=await request('/device/start','POST',{label});
 if(!uuid(start.sessionId)||!hex(start.deviceKey)||!hex(start.pairingCode)||start.pageId!==PAGE||!Number.isFinite(start.expiresAt)||start.expiresAt<=now()||start.expiresAt>now()+11*60_000)throw Error('Device enrollment response rejected');
 key=start.deviceKey;const id=start.sessionId;
 const view=value=>{
  if(value.id!==id||value.pageId!==PAGE||!['pending_page','pending_owner','active'].includes(value.state)||!Number.isFinite(value.expiresAt)||value.expiresAt<=now())throw Error('Device session view rejected');
  return {id,state:value.state,expiresAt:value.expiresAt,customerReference:typeof value.customerReference==='string'?value.customerReference.slice(-6):null,workspaceLabel:typeof value.workspaceLabel==='string'?value.workspaceLabel.slice(0,120):null};
 };
 return Object.freeze({sessionId:id,pairingMessage:'AGENT-CONNECT '+start.pairingCode,
  status:async()=>view(await request(`/device/${id}/status`)),
  activate:async({workspaceLabel,confirmed})=>{if(confirmed!==true)throw Error('Local owner confirmation required');return view(await request(`/device/${id}/activate`,'POST',{workspaceLabel,attended:true}));},
  tasks:async()=>{const r=await request(`/device/${id}/tasks`);if(!Array.isArray(r.tasks)||r.tasks.length>10)throw Error('Invalid local task list');return r.tasks.map(t=>{if(!uuid(t.id)||!uuid(t.requestId)||t.state!=='awaiting_owner'||typeof t.goal!=='string'||!t.goal.trim()||t.goal.length>12000||createHash('sha256').update(t.goal).digest('hex')!==t.goalHash||!Number.isFinite(t.expiresAt)||t.expiresAt<=now())throw Error('Invalid local task');return {id:t.id,requestId:t.requestId,state:t.state,goal:t.goal,goalHash:t.goalHash,expiresAt:t.expiresAt};});},
  taskStatus:async taskId=>{if(!uuid(taskId))throw Error('Invalid local task');const r=await request(`/device/${id}/tasks/${taskId}/status`);if(r.id!==taskId||typeof r.state!=='string')throw Error('Task status rejected');return {state:r.state,delivered:r.delivered===true,deliveryState:r.deliveryState};},
  acceptTask:async({id:taskId,approvedGoalHash})=>{if(!uuid(taskId)||!hex(approvedGoalHash))throw Error('Invalid local task acceptance');const r=await request(`/device/${id}/tasks/${taskId}/accept`,'POST',{approvedGoalHash});if(r.id!==taskId||r.state!=='running'||r.goalHash!==approvedGoalHash||!hex(r.lease))throw Error('Task lease rejected');return {state:r.state,goalHash:r.goalHash,lease:r.lease};},
  declineTask:async taskId=>{if(!uuid(taskId))throw Error('Invalid local task');const r=await request(`/device/${id}/tasks/${taskId}/decline`,'POST',{});if(r.id!==taskId||r.state!=='declined')throw Error('Task decline rejected');return {state:'declined'};},
  cancelTask:async(taskId,lease)=>{if(!uuid(taskId)||!hex(lease))throw Error('Invalid local cancellation');const r=await request(`/device/${id}/tasks/${taskId}/cancel`,'POST',{lease});if(r.id!==taskId||r.state!=='cancelled')throw Error('Task cancellation not verified');return {state:'cancelled'};},
  submitResult:async(taskId,result)=>{if(!uuid(taskId)||!hex(result?.lease))throw Error('Invalid local result');const r=await request(`/device/${id}/tasks/${taskId}/result`,'POST',result);if(r.id!==taskId||r.state!=='result_ready')throw Error('Result submission not verified');return {state:r.state,delivered:r.delivered===true};},
  revoke:async()=>{try{const result=await request(`/device/${id}/revoke`,'POST',{});if(result.id!==id||result.state!=='revoked')throw Error('Remote revocation not confirmed');return {state:'revoked'};}finally{closed=true;key=null;}}
 });
}
import {createHash} from 'node:crypto';
