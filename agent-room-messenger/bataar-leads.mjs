import {createHash} from 'node:crypto';
export async function handleBataarAdmin(path,method,b,db){
 if(path==='/operator/bataar/leads'&&method==='GET')return {leads:(await db.query("SELECT id,data,created_at,updated_at FROM bataar_travel_leads WHERE page_id='440088839501409' AND stage='pending-staff' AND COALESCE(data->>'isTest','false')<>'true' ORDER BY created_at DESC LIMIT 100")).rows};
 if(path==='/operator/bataar/leads/update'&&method==='POST'){
  if(!/^BT-[A-F0-9]{10}$/.test(b.id||'')||!['new','contacted','closed'].includes(b.status)||typeof b.note!=='string'||b.note.length>1000||typeof b.version!=='string'||!Number.isFinite(Date.parse(b.version)))return {error:'Invalid lead update'};
  const patch=JSON.stringify({staffStatus:b.status,staffNote:b.note,staffUpdatedAt:new Date().toISOString()});
  const q=await db.query("UPDATE bataar_travel_leads SET data=data||$2::jsonb,updated_at=NOW() WHERE id=$1 AND page_id='440088839501409' AND stage='pending-staff' AND COALESCE(data->>'isTest','false')<>'true' AND updated_at=$3::timestamptz RETURNING id",[b.id,patch,b.version]);
  return q.rowCount?{updated:true}:{error:'Хүсэлт өөрчлөгдсөн байна. Дахин ачаалаад шалгана уу.'};
 }
 return null;
}
export const bataarAdminHtml=String.raw`<!doctype html><html lang="mn"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Батаарын Өлгий — Хүсэлтүүд</title><style>body{font:16px/1.6 system-ui;background:#f4f3ed;color:#183b3b;max-width:1000px;margin:30px auto;padding:20px}h1{line-height:1.2}button,input,select,textarea{font:inherit;padding:10px;border:1px solid #aabbb7;border-radius:8px}button{background:#185b50;color:white;cursor:pointer}article{background:white;padding:22px;margin:18px 0;border-radius:14px}textarea{display:block;width:90%;min-height:65px}label{display:block;margin:10px 0}.muted{color:#596e68}#status{font-weight:bold}nav{display:flex;gap:12px;flex-wrap:wrap}a{color:#185b50}</style><h1>Батаарын Өлгий · Аяллын хүсэлт</h1><p class="muted">Хариуцагч: Баттулга Эрдэнэбаян. Энэ бүртгэл нь захиалга, төлбөр баталсан гэсэн үг биш.</p><form id="login"><label>Операторын түлхүүр <input id="key" type="password" autocomplete="off" required></label><button>Нэвтрэх</button></form><section id="desk" hidden><nav><button id="refresh">Шинэчлэх</button><select id="filter" aria-label="Төлөвөөр шүүх"><option value="all">Бүгд</option><option value="new">Шинэ</option><option value="contacted">Холбогдсон</option><option value="closed">Хаасан</option></select><button id="logout">Гарах</button><a href="https://business.facebook.com/latest/inbox/all/?asset_id=440088839501409" target="_blank" rel="noopener">Page Inbox нээх</a></nav><p id="counts"></p><p>Самбар нээлттэй үед минут тутам шинэчлэгдэнэ. Гаднын SMS/имэйл мэдэгдэл холбогдоогүй.</p><div id="list"></div></section><p id="status" role="status"></p><script>
let token='',rows=[],busy=false;
const $=id=>document.getElementById(id),labels={new:'Шинэ',contacted:'Холбогдсон',closed:'Хаасан'};
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});const j=await r.json();if(!r.ok||j.error)throw Error(j.error||'Сервертэй холбогдож чадсангүй');return j;}
function render(){const counts={new:0,contacted:0,closed:0};rows.forEach(r=>counts[r.data.staffStatus||'new']++);$('counts').textContent=Object.entries(counts).map(([k,v])=>labels[k]+': '+v).join(' · ');$('list').replaceChildren();for(const r of rows){const d=r.data,s=d.staffStatus||'new';if($('filter').value!=='all'&&$('filter').value!==s)continue;const card=el('article');card.append(el('h2',r.id),el('p','Ирсэн: '+new Date(r.created_at).toLocaleString('mn-MN',{timeZone:'Asia/Ulaanbaatar'})),el('p','Хугацаа: '+(d.dates||'—')+' · Хүн: '+(d.people||'—')),el('p','Аялал: '+(d.tour||'—')),el('p','Холбоо: '+(d.contact||'Энэ Messenger яриагаар')));const sel=el('select');sel.setAttribute('aria-label','Хүсэлтийн төлөв');for(const [k,v]of Object.entries(labels)){const o=el('option',v);o.value=k;sel.append(o);}sel.value=s;const note=el('textarea');note.value=d.staffNote||'';note.maxLength=1000;note.placeholder='Ажилтны тэмдэглэл. Нууц үг, данс, хүүхдийн мэдээлэл бүү оруул.';const save=el('button','Хадгалах');save.onclick=async()=>{save.disabled=true;busy=true;try{await api('/operator/bataar/leads/update',{id:r.id,status:sel.value,note:note.value,version:r.updated_at});note.dataset.dirty='';await load();$('status').textContent='Хадгаллаа.';}catch(e){$('status').textContent=e.message;}finally{save.disabled=false;busy=false;}};note.oninput=()=>note.dataset.dirty='yes';sel.onchange=()=>note.dataset.dirty='yes';card.append(sel,note,save);$('list').append(card);}if(!$('list').children.length)$('list').append(el('p','Энэ төлөвт бодит хүсэлт алга. Туршилтын хүсэлтүүдийг харуулахгүй.'));}
async function load(){try{rows=(await api('/operator/bataar/leads')).leads;$('login').hidden=true;$('desk').hidden=false;render();$('status').textContent='Сүүлд шинэчилсэн: '+new Date().toLocaleTimeString('mn-MN',{timeZone:'Asia/Ulaanbaatar'});}catch(e){$('status').textContent=e.message;}}
$('login').onsubmit=async e=>{e.preventDefault();token=$('key').value;$('key').value='';await load();};$('refresh').onclick=()=>{if(document.querySelector('[data-dirty="yes"]')){$('status').textContent='Өөрчлөлтөө эхлээд хадгална уу.';return;}load();};$('filter').onchange=()=>{if(document.querySelector('[data-dirty="yes"]')){$('status').textContent='Өөрчлөлтөө эхлээд хадгална уу.';return;}render();};$('logout').onclick=()=>{token='';rows=[];$('list').replaceChildren();$('desk').hidden=true;$('login').hidden=false;$('counts').textContent='';$('status').textContent='Гарлаа.';};setInterval(()=>{if(token&&!busy&&!document.querySelector('[data-dirty="yes"]')&&document.visibilityState==='visible')load();},60000);
</script></html>`;
export const leadSchema=`CREATE TABLE IF NOT EXISTS bataar_travel_leads(
 id TEXT PRIMARY KEY,page_id TEXT NOT NULL CHECK(page_id='440088839501409'),sender_id TEXT NOT NULL,
 stage TEXT NOT NULL,data JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS bataar_lead_sender ON bataar_travel_leads(sender_id,created_at DESC);`;
const yes=/^(тийм|зөвшөөрнө|зөвшөөрч байна|баталъя|батална|yes|confirm|za|tiim|зөв|ok)$/iu;
const no=/^(үгүй|цуцлах|цуцал|болих|no|cancel|ugui)$/iu;
const start=/аяллын хүсэлт|хүсэлт бүртг|аялал захиал|захиалъя|захиалга өг|аялмаар|travel request|book (?:a |the )?tour/iu;
const privacy='https://agent-room-messenger-ingress.onrender.com/bataar/privacy';
export function leadStep(previous,text){
 const raw=String(text||'').trim(),t=raw.toLowerCase().replace(/[.!?]+$/,'').trim();
 const state=previous?{stage:previous.stage,data:{...previous.data}}:null;
 if(!state&&!start.test(t))return null;
 if(!state)return {stage:'consent',data:/туршилт|test/i.test(raw)?{isTest:true}:{},reply:'Аяллын хүсэлт бүртгүүлэх үү? Хугацаа, хүний тоо, аяллын чиглэл, хүсвэл утсыг тань энэ чат болон баазын Render серверт хадгалж, баазын эрхтэй ажилтан үзнэ. Энэ нь захиалга баталсан гэсэн үг биш. Зөвшөөрвөл “Тийм”, хүсэхгүй бол “Үгүй” гэж бичнэ үү. Нууцлал: '+privacy};
 if(no.test(t)&&state.stage!=='pending-staff')return {stage:'cancelled',data:{},reply:'Хүсэлт бүртгэхийг цуцаллаа. Аяллын ерөнхий асуултаа асууж болно.'};
 if(state.stage==='consent')return yes.test(t)?{stage:'dates',data:{...state.data,consentedAt:new Date().toISOString()},reply:'Хэзээ ирэхээр төлөвлөж байна вэ? Жишээ нь 2026-12-10–2026-12-15. Огноо тодорхойгүй бол “Тодорхойгүй” гэж бичиж болно.'}:{...state,reply:'Мэдээллээ бүртгүүлэхийг зөвшөөрвөл “Тийм”, хүсэхгүй бол “Үгүй” гэж бичнэ үү.'};
 if(state.stage==='dates'){
   if(!raw||raw.length>120)return {...state,reply:'Ирэх, буцах огноо эсвэл ойролцоох сар/хугацааг 120 тэмдэгтэд багтаан бичнэ үү.'};
   return {stage:'people',data:{...state.data,dates:raw},reply:'Нийт хэдэн хүн аялах вэ? Зөвхөн тоогоор бичнэ үү. Хүүхдийн нэр, нас зэрэг хувийн мэдээлэл хэрэггүй.'};
 }
 if(state.stage==='people'){
   if(!/^\d{1,3}$/.test(t)||Number(t)<1||Number(t)>100)return {...state,reply:'Нийт хүний тоог 1–100 хооронд тоогоор бичнэ үү. Бүлгийн багтаамжийг ажилтан тусад нь батална.'};
   return {stage:'tour',data:{...state.data,people:Number(t)},reply:'Ямар аялал сонирхож байна вэ? Жишээ нь ирвэс ажиглах, Хэрмэн цав, баазад амрах. Товч бичнэ үү.'};
 }
 if(state.stage==='tour'){
   if(!raw||raw.length>200)return {...state,reply:'Сонирхсон аяллаа 200 тэмдэгтэд багтааж бичнэ үү.'};
   return {stage:'contact',data:{...state.data,tour:raw},reply:'Буцааж холбогдох утсаа үлдээхийг хүсвэл дугаараа бичнэ үү. Заавал биш — “Алгасах” гэж бичвэл энэ Messenger яриагаар холбогдож болно.'};
 }
 if(state.stage==='contact'){
   const skip=/^(алгасах|skip|algasah)$/iu.test(t);const phone=raw.replace(/[\s()-]/g,'');
   if(!skip&&!/^\+?\d{8,15}$/.test(phone))return {...state,reply:'Утсаа 8–15 оронтой бичих, эсвэл “Алгасах” гэж бичнэ үү. Нууц үг, дансны мэдээлэл битгий илгээгээрэй.'};
   const data={...state.data,contact:skip?'Энэ Messenger яриагаар':phone};
   const wildlife=/ирвэс|snow\s*leopard/iu.test(data.tour)?'\nИрвэс байгальд чөлөөтэй амьдардаг тул ажиглалт нь амьтдын хөдөлгөөн, тухайн үеийн нөхцөлөөс хамаарна; заавал харагдана гэж амлах боломжгүй.':' ';
   return {stage:'confirm',data,reply:`Хүсэлтийн мэдээлэл:\nХугацаа: ${data.dates}\nХүн: ${data.people}\nЧиглэл: ${data.tour}\nХолбоо: ${data.contact}${wildlife.trimEnd()}\nЭнэ мэдээллийг баазын ажилтанд үзүүлэхээр бүртгэх үү? “Баталъя” эсвэл “Цуцлах” гэж бичнэ үү. Үнэ, сул байр, захиалгыг ажилтан эцэслэнэ.`};
 }
 if(state.stage==='confirm')return yes.test(t)?{stage:'pending-staff',data:state.data,reply:'Хүсэлтийг ажилтан шалгах төлөвтэй бүртгэлээ. Захиалга батлагдаагүй, төлбөр авахгүй. Яаралтай бол 99530099 дугаарт холбогдоно уу.'}:{...state,reply:'Мэдээлэл зөв бол “Баталъя”, өөрчлөх бол “Цуцлах” гэж бичээд дахин хүсэлт эхлүүлж болно.'};
 return null;
}
export async function handleTravelLead(db,event){
 const old=(await db.query("SELECT id,stage,data FROM bataar_travel_leads WHERE page_id=$1 AND sender_id=$2 AND stage NOT IN ('cancelled','pending-staff') ORDER BY created_at DESC LIMIT 1",[event.page_id,event.sender_id])).rows[0];
 const next=leadStep(old,event.message_text);if(!next)return null;
 const id=old?.id||'BT-'+createHash('sha256').update(event.source_id).digest('hex').slice(0,10).toUpperCase();
 await db.query(`INSERT INTO bataar_travel_leads(id,page_id,sender_id,stage,data) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(id) DO UPDATE SET stage=EXCLUDED.stage,data=EXCLUDED.data,updated_at=NOW()`,[id,event.page_id,event.sender_id,next.stage,JSON.stringify(next.data)]);
 return next.reply+(next.stage==='pending-staff'?'\n'+(next.data.isTest?'ТУРШИЛТ — бодит аяллын хүсэлт биш.\n':'')+'Хүсэлтийн дугаар: '+id:'');
}