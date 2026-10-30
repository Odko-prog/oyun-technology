import test from 'node:test';
import assert from 'node:assert/strict';
import {dueSlot,runSlot,validateDraft,PAGE_ID} from './bataar-schedule.mjs';
const startAt='2026-10-29T00:00:00+08:00';
const now=new Date('2026-10-29T05:01:00Z');
const draft={message:'Аялал төлөвлөх тухай жишээ. '.repeat(6)+'https://bataartravel.mn',verified:true,sources:[{url:'https://bataartravel.mn',checked:'2026-10-29'}]};
function harness(){let claimed=false,publishes=0;const records=[];return {records,get publishes(){return publishes},pool:{async query(sql,args){records.push([sql,args]);if(sql.startsWith('INSERT')){if(claimed)return {rowCount:0};claimed=true;return {rowCount:1};}if(sql.startsWith('SELECT'))return {rows:[]};return {rowCount:1};}},publish:async()=>{publishes++;return PAGE_ID+'_123';}};}
test('four Ulaanbaatar slots, no missed-slot bursts, explicit cutover required',()=>{
  for(const hour of [1,5,9,13])assert.ok(dueSlot(new Date(`2026-10-29T${String(hour).padStart(2,'0')}:00:00Z`),startAt));
  assert.equal(dueSlot(new Date('2026-10-29T05:15:00Z'),startAt),null);
  assert.equal(dueSlot(now,undefined),null);
  assert.equal(dueSlot(now,'2026-10-30T00:00:00Z'),null);
});
test('wrong Page identity cannot publish',async()=>{const h=harness();assert.equal((await runSlot({...h,now,startAt,enabled:true,generate:async()=>draft,verifyIdentity:async()=>'1309261702280978'})).status,'review');assert.equal(h.publishes,0);});
test('same slot cannot dispatch twice',async()=>{const h=harness();const args={...h,now,startAt,enabled:true,generate:async()=>draft,verifyIdentity:async()=>PAGE_ID};assert.equal((await runSlot(args)).status,'published');assert.equal((await runSlot(args)).status,'already-attempted');assert.equal(h.publishes,1);});
test('uncertain send is held, never automatically repeated',async()=>{const h=harness();let sends=0;const args={...h,now,startAt,enabled:true,generate:async()=>draft,verifyIdentity:async()=>PAGE_ID,publish:async()=>{sends++;throw Error('timeout');}};assert.equal((await runSlot(args)).status,'review');assert.equal((await runSlot(args)).status,'already-attempted');assert.equal(sends,1);});
test('disabled worker does not touch database or network',async()=>{const h=harness();assert.equal((await runSlot({...h,now,startAt})).status,'disabled');assert.equal(h.records.length,0);});
test('source outage skips this slot without sending and preserves normal scheduling',async()=>{const h=harness();const r=await runSlot({...h,now,startAt,enabled:true,generate:async()=>{throw Object.assign(Error('unavailable'),{code:'SOURCE_UNAVAILABLE'});}});assert.equal(r.status,'skipped');assert.equal(h.publishes,0);assert.ok(h.records.some(([q])=>q.includes("status='skipped'")));});
test('source domain lookalikes and unverified content are rejected',()=>{assert.throws(()=>validateDraft({...draft,verified:false}));assert.throws(()=>validateDraft({...draft,sources:[{url:'https://bataartravel.mn.attacker.example',checked:'2026-10-29'}]}));});
test('a full day or native scheduled slot is skipped without a send or fatal review',async()=>{const h=harness();const result=await runSlot({...h,now,startAt,enabled:true,generate:async()=>{throw Object.assign(Error('reserved'),{code:'SLOT_RESERVED'});}});assert.equal(result.status,'skipped');assert.equal(h.publishes,0);assert.equal((await runSlot({...h,now,startAt,enabled:true})).status,'already-attempted');});