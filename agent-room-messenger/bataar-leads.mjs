import {createHash} from 'node:crypto';
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
   return {stage:'confirm',data,reply:`Хүсэлтийн мэдээлэл:\nХугацаа: ${data.dates}\nХүн: ${data.people}\nЧиглэл: ${data.tour}\nХолбоо: ${data.contact}\nЭнэ мэдээллийг баазын ажилтанд үзүүлэхээр бүртгэх үү? “Баталъя” эсвэл “Цуцлах” гэж бичнэ үү. Үнэ, сул байр, захиалгыг ажилтан эцэслэнэ.`};
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
