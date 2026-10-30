// Staged component. Importing this module never starts a worker or publishes.
export const PAGE_ID='440088839501409';
export const HOURS=[9,13,17,21];
export function dueSlot(now,startAt){
  if(!startAt||!Number.isFinite(Date.parse(startAt))||now.getTime()<Date.parse(startAt))return null;
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ulaanbaatar',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
  if(!HOURS.includes(Number(p.hour))||Number(p.minute)>14)return null;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00+08:00`;
}
export async function initializeSchedule(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS bataar_publication_slots (
    slot TEXT PRIMARY KEY, page_id TEXT NOT NULL, status TEXT NOT NULL,
    message TEXT, sources JSONB, provider_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
export function validateDraft(draft){
  if(!draft||typeof draft.message!=='string'||draft.message.length<100||draft.message.length>4000||draft.verified!==true||!Array.isArray(draft.sources)||!draft.sources.length)throw Error('Draft needs review');
  for(const source of draft.sources){
    const url=new URL(source.url);
    const allowed=['bataartravel.mn','globalsnowleopard.org','unwto.org','untourism.int','1212.mn','nso.mn','montsame.mn','ncch.gov.mn','gurvantes.omnogovi.khural.mn','usgs.gov','science.nasa.gov','si.edu','amnh.org','nature.com'];
    if(url.protocol!=='https:'||url.username||url.password||!allowed.some(h=>url.hostname===h||url.hostname.endsWith('.'+h))||typeof source.checked!=='string'||!Number.isFinite(Date.parse(source.checked)))throw Error('Unverified source');
    if(!draft.message.includes(source.url))throw Error('Source missing from post');
  }
  return draft;
}
export async function runSlot({pool,now=new Date(),startAt,generate,verifyIdentity,publish,enabled=false}){
  if(!enabled)return {status:'disabled'};
  const slot=dueSlot(now,startAt);if(!slot)return {status:'outside-slot'};
  // Persist the claim BEFORE any external request. Unknown outcomes remain held.
  const claim=await pool.query("INSERT INTO bataar_publication_slots(slot,page_id,status) VALUES($1,$2,'claimed') ON CONFLICT(slot) DO NOTHING RETURNING slot",[slot,PAGE_ID]);
  if(!claim.rowCount)return {status:'already-attempted',slot};
  let stage='preparation';
  try{
    const history=(await pool.query('SELECT slot,message,provider_id,status FROM bataar_publication_slots ORDER BY slot DESC LIMIT 24')).rows;
    const today=slot.slice(0,10);
    if(history.filter(r=>r.slot.startsWith(today)&&r.status==='published').length>=4)throw Error('Daily cap');
    const draft=validateDraft(await generate({slot,history}));
    if(history.some(r=>r.message===draft.message))throw Error('Duplicate content');
    if(String(await verifyIdentity())!==PAGE_ID)throw Error('Wrong Page');
    await pool.query("UPDATE bataar_publication_slots SET status='dispatching',message=$2,sources=$3,updated_at=NOW() WHERE slot=$1",[slot,draft.message,JSON.stringify(draft.sources)]);
    stage='publication';
    const id=await publish(draft.message);
    if(typeof id!=='string'||!id.startsWith(PAGE_ID+'_'))throw Error('Publication outcome uncertain');
    await pool.query("UPDATE bataar_publication_slots SET status='published',provider_id=$2,updated_at=NOW() WHERE slot=$1",[slot,id]);
    return {status:'published',slot,id};
  }catch(error){
    if(stage==='preparation'&&['SLOT_RESERVED','SOURCE_UNAVAILABLE'].includes(error?.code)){
      await pool.query("UPDATE bataar_publication_slots SET status='skipped',updated_at=NOW() WHERE slot=$1",[slot]);
      return {status:'skipped',slot};
    }
    await pool.query("UPDATE bataar_publication_slots SET status='review',updated_at=NOW() WHERE slot=$1",[slot]);
    return {status:'review',slot,stage};
  }
}
