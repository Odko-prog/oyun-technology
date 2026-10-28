import test from 'node:test';import assert from 'node:assert/strict';
import {acceptBataarMessages,withinReplyWindow,messengerClient,processBataarMessage,validateMessengerDraft,startBataarMessenger} from './bataar-messenger.mjs';
const PAGE='440088839501409';
const event={source_id:'mid1',page_id:PAGE,sender_id:'123456',message_text:'Хаана вэ?',source_timestamp:Date.now()};
test('signed-event routing isolates the exact Page, skips echoes, and inserts idempotently',async()=>{
 const seen=new Set(),values=[];const db={async query(sql,args){values.push(args);const old=seen.has(args[0]);seen.add(args[0]);return {rowCount:old?0:1};}};
 const m={sender:{id:'123456'},recipient:{id:PAGE},timestamp:Date.now(),message:{mid:'m1',text:'hi'}};
 const body={object:'page',entry:[{id:'1309261702280978',messaging:[m]},{id:PAGE,messaging:[m,{...m,message:{...m.message,is_echo:true}},{...m,recipient:{id:'999'}}]}]};
 assert.equal(await acceptBataarMessages(db,body,{enabled:true}),1);assert.equal(await acceptBataarMessages(db,body,{enabled:true}),0);assert.equal(values[0][1],PAGE);
 assert.equal(await acceptBataarMessages(db,body,{enabled:false}),0);
});
test('reply window rejects absent, old and future events',()=>{const n=Date.now();assert.ok(withinReplyWindow(n,n));for(const t of [null,0,n-24*3600000,n+120000])assert.equal(withinReplyWindow(t,n),false);});
test('outbound client cannot message another Page, another recipient, or expired context',async()=>{
 let calls=0;const client=messengerClient({BATAAR_MESSENGER_PAGE_ACCESS_TOKEN:'secret'},async(url,options)=>{calls++;const b=JSON.parse(options.body);assert.equal(url,'https://graph.facebook.com/v26.0/'+PAGE+'/messages');assert.equal(b.recipient.id,event.sender_id);assert.equal(b.messaging_type,'RESPONSE');return {ok:true,json:async()=>({recipient_id:event.sender_id,message_id:'reply1'})};});
 await assert.rejects(client.send({...event,page_id:'1309261702280978'},'hi'));await assert.rejects(client.send({...event,sender_id:PAGE},'hi'));await assert.rejects(client.send({...event,source_timestamp:0},'hi'));assert.equal(calls,0);assert.equal(await client.send(event,'hello'),'reply1');assert.equal(calls,1);
});
test('draft requires verification, bounds text and discloses AI',()=>{assert.match(validateMessengerDraft({verified:true,message:'Манай бааз Гурвантэс суманд байрладаг.'}),/^AI туслах:/);assert.throws(()=>validateMessengerDraft({verified:false,message:'unverified'}));assert.throws(()=>validateMessengerDraft({verified:true,message:'EAA'+'a'.repeat(50)}));});
function fakePool(){const writes=[];return {writes,async query(sql,args){writes.push({sql,args});return {rowCount:0,rows:[]};}};}
test('generation sees only same-sender/Page history, uncertain send held for review without retry',async()=>{
 const pool=fakePool();let sends=0;const status=await processBataarMessage(pool,event,{generate:async input=>{assert.equal(input.kind,'messenger');return {verified:true,message:'Байршлын мэдээллийг 99530099 дугаараар авна уу.'};},send:async()=>{sends++;throw Error('timeout after POST');}});
 assert.equal(status,'review');assert.equal(sends,1);assert.ok(pool.writes.some(x=>x.args?.[1]==='dispatching'));const history=pool.writes.find(x=>x.sql.includes('LIMIT 8'));assert.deepEqual(history.args,[PAGE,event.sender_id,event.source_id]);
});
test('human handoff persists and bypasses model; existing handoff suppresses replies',async()=>{
 const pool=fakePool();let generated=false;await processBataarMessage(pool,{...event,message_text:'Хүнтэй холбогдох'},{generate:async()=>{generated=true;},send:async()=> 'reply2'});assert.equal(generated,false);assert.ok(pool.writes.some(x=>x.sql.includes('INSERT INTO bataar_messenger_handoffs')));
 const held={async query(sql){return {rowCount:sql.startsWith('SELECT')?1:0,rows:[]};}};assert.equal(await processBataarMessage(held,event,{generate:()=>{throw Error('must not run');},send:()=>{throw Error('must not send');}}),'human-handoff');
});
test('Messenger remains off without explicit flag and does no network IO',async()=>{const worker=startBataarMessenger({}, {env:{},fetcher:()=>{throw Error('unexpected IO');}});await worker.done;assert.equal(worker.state.status,'disabled');await worker.stop();});
