// Read-only presentation of a trusted, tenant-scoped persistent request.
// This module never sends progress messages or schedules retries.
export function presentJobStatus(request) {
  const state = request?.status;
  if (state === 'dispatching') return {state:'delivering',label:'Үр дүнг хүргэж байна',terminal:false};
  if (state === 'processing') return {state:'running',label:'Ажлыг гүйцэтгэж байна',terminal:false};
  if (state === 'received' || state === 'pending' || state === 'queued') return {state:'queued',label:'Ажил дараалалд байна',terminal:false};
  if (state === 'awaiting_customer') return {state:'awaiting_customer',label:'Таны нэмэлт мэдээлэл эсвэл зөвшөөрөл хэрэгтэй',terminal:false};
  if (state === 'completed' && request.provider_id) return {state:'completed',label:'Үр дүнг илгээсэн',terminal:true};
  // A database completion without a provider receipt must not imply delivery.
  return {state:'review',label:'Ажлын төлөвийг шалгах шаардлагатай',terminal:false};
}

// Caller must obtain senderId from a verified signed Page event/session,
// never from a browser-supplied conversation/profile ID.
export async function readOwnedJobStatus(pool,requestId,trustedBinding) {
  if(trustedBinding?.pageId!=='1309261702280978' ||
     typeof trustedBinding.senderId!=='string' || !/^[0-9]{5,32}$/.test(trustedBinding.senderId) ||
     typeof requestId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) return null;
  const result=await pool.query('SELECT status,provider_id FROM messenger_requests WHERE id=$1 AND sender_id=$2 LIMIT 1',[requestId,trustedBinding.senderId]);
  return result.rows[0]?presentJobStatus(result.rows[0]):null;
}

// The worker supplies this persisted job; no customer-entered sender is used.
export async function priorJobStatuses(pool,job) {
  if(!job?.sender_id || !job.id || !Number.isFinite(new Date(job.created_at).valueOf())) throw Error('Invalid persisted job');
  const result=await pool.query('SELECT id,status,provider_id FROM messenger_requests WHERE sender_id=$1 AND id<>$2 AND created_at<$3 ORDER BY created_at DESC LIMIT 8',[job.sender_id,job.id,job.created_at]);
  return result.rows.map(row=>({request_id:row.id,...presentJobStatus(row)}));
}
