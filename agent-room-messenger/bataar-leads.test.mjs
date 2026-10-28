import test from 'node:test';import assert from 'node:assert/strict';
import {leadStep,handleTravelLead} from './bataar-leads.mjs';
import {processBataarMessage} from './bataar-messenger.mjs';
test('ordinary price/location questions do not silently enroll a visitor',()=>{for(const t of ['Хаана вэ?','Үнэ хэд вэ?','Захиалгын нөхцөл юу вэ?'])assert.equal(leadStep(null,t),null);});
test('intake explicitly asks consent and does not extract phone/details before consent',()=>{const s=leadStep(null,'Аяллын хүсэлт 12 сарын10,4хүн,99112233');assert.equal(s.stage,'consent');assert.deepEqual(s.data,{});assert.match(s.reply,/Render/);assert.match(s.reply,/Зөвшөөрвөл/);const refused=leadStep(s,'Үгүй');assert.equal(refused.stage,'cancelled');assert.deepEqual(refused.data,{});});
test('intake validates count, optional phone, confirmation and never promises booking',()=>{
 let s=leadStep(null,'Аяллын хүсэлт');s=leadStep(s,'Тийм');s=leadStep(s,'2026-12-10–2026-12-15');assert.equal(leadStep(s,'4 хүүхэд,нэр:Ану').stage,'people');s=leadStep(s,'4');s=leadStep(s,'Ирвэс ажиглах');assert.equal(leadStep(s,'not a phone').stage,'contact');s=leadStep(s,'Алгасах');assert.equal(s.stage,'confirm');assert.equal(s.data.contact,'Энэ Messenger яриагаар');assert.equal(leadStep(s,'за би бодъё').stage,'confirm');s=leadStep(s,'Баталъя');assert.equal(s.stage,'pending-staff');assert.match(s.reply,/Захиалга батлагдаагүй/);
});
test('cancellation clears captured optional contact',()=>{const s=leadStep({stage:'confirm',data:{contact:'99112233'}},'Цуцлах');assert.equal(s.stage,'cancelled');assert.deepEqual(s.data,{});});
test('lead persistence is scoped to exact Page and sender and source-derived reference',async()=>{const calls=[];const db={async query(sql,args){calls.push({sql,args});return {rows:[],rowCount:0};}};const e={page_id:'440088839501409',sender_id:'123456',source_id:'test-id',message_text:'Аяллын хүсэлт'};await handleTravelLead(db,e);assert.deepEqual(calls[0].args,[e.page_id,e.sender_id]);assert.equal(calls[1].args[1],e.page_id);assert.equal(calls[1].args[2],e.sender_id);assert.match(calls[1].args[0],/^BT-[A-F0-9]{10}$/);assert.equal(calls[1].args[3],'consent');});
test('complete real dispatcher flow bypasses model and only queues after final opt-in',async()=>{
 let lead=null;const sent=[];const db={async query(sql,args){
   if(sql.startsWith('SELECT id,stage,data FROM bataar_travel_leads'))return {rows:lead&&!['pending-staff','cancelled'].includes(lead.stage)?[lead]:[],rowCount:lead?1:0};
   if(sql.includes('INSERT INTO bataar_travel_leads'))lead={id:args[0],stage:args[3],data:JSON.parse(args[4])};
   return {rows:[],rowCount:0};
 }};
 const inputs=['Аяллын хүсэлт','Тийм','2026 оны12сар','4','Хэрмэн цав','Алгасах','Баталъя'];
 for(const [i,message_text] of inputs.entries()){
   const status=await processBataarMessage(db,{source_id:'source'+i,page_id:'440088839501409',sender_id:'123456',source_timestamp:Date.now(),message_text},{generate:()=>{throw Error('intake must not use model');},send:async(e,text)=>{sent.push(text);return 'sent'+i;}});
   assert.equal(status,'sent');if(i<6)assert.notEqual(lead.stage,'pending-staff');
 }
 assert.equal(lead.stage,'pending-staff');assert.equal(sent.length,7);assert.match(sent[6],/Хүсэлтийн дугаар: BT-/);assert.equal(lead.data.people,4);assert.ok(lead.data.consentedAt);assert.ok(!sent.some(x=>x.startsWith('AI туслах')));
});
