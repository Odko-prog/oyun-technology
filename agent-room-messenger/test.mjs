import './operator-diagnostics.test.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {validSignature,extractEvents,extractOutgoingEvents,sameSecret} from './core.mjs';
const page='1309261702280978';
const fixture=()=>({object:'page',entry:[{id:page,messaging:[{sender:{id:'1234'},recipient:{id:page},timestamp:100,message:{mid:'fixture-1',text:'Synthetic test'}}]}]});
test('HMAC accepts authentic bytes and rejects tampering',()=>{const raw=Buffer.from('{}'),secret='fixture-secret',sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');assert.ok(validSignature(raw,sig,secret));assert.ok(!validSignature(Buffer.from('{ }'),sig,secret));assert.ok(!validSignature(raw,sig,''));assert.ok(!validSignature(raw,'bad',secret))});
test('extracts only the target API Page',()=>{assert.equal(extractEvents(fixture(),page).length,1);assert.equal(extractEvents(fixture(),'61595841421312').length,0)});
test('echo is ignored',()=>{const b=fixture();b.entry[0].messaging[0].message.is_echo=true;assert.equal(extractEvents(b,page).length,0)});
test('Page echo updates only the correct customer context and never creates an inbound job',()=>{
 const b=fixture(),e=b.entry[0].messaging[0];e.sender.id=page;e.recipient.id='4321';e.message.is_echo=true;e.message.attachments=[{type:'image',payload:{url:'https://private.example/image'}}];
 assert.equal(extractEvents(b,page).length,0);
 const out=extractOutgoingEvents(b,page);assert.equal(out.length,1);assert.equal(out[0].senderId,'4321');assert.deepEqual(out[0].attachments,['image']);assert.ok(!JSON.stringify(out).includes('private.example'));
 e.sender.id='999';assert.equal(extractOutgoingEvents(b,page).length,0);
});
test('photo-only request retained without remote URL',()=>{const b=fixture(),m=b.entry[0].messaging[0].message;delete m.text;m.attachments=[{type:'image',payload:{url:'https://do-not-fetch.invalid/private'}}];const a=extractEvents(b,page);assert.deepEqual(a[0].attachments,['image']);assert.ok(!JSON.stringify(a).includes('do-not-fetch'))});
test('Meta CDN input references remain bound to the same signed-event message',()=>{const b=fixture(),m=b.entry[0].messaging[0].message;m.attachments=[{type:'file',payload:{url:'https://lookaside.fbsbx.com/attachment/?synthetic=1'}},{type:'file',payload:{url:'https://evil.test/private'}}];const e=extractEvents(b,page)[0];assert.equal(e.senderId,'1234');assert.equal(e.sourceId,'fixture-1');assert.deepEqual(e.attachmentRefs,[{type:'file',url:'https://lookaside.fbsbx.com/attachment/?synthetic=1'}]);});
test('unsupported payload and invalid sender handled',()=>{assert.throws(()=>extractEvents({},page));const b=fixture();b.entry[0].messaging[0].sender.id='../unsafe';assert.equal(extractEvents(b,page).length,0)});
test('comparison fails closed',()=>{assert.equal(sameSecret('',''),false);assert.equal(sameSecret(undefined,'x'),false);assert.equal(sameSecret('a','aa'),false);assert.equal(sameSecret('good','good'),true)});

test('operator pending exposes whole durable queue totals without changing delivery',async()=>{
 const {handleOperator}=await import('./operator.mjs');const queries=[];
 const summary={total:150,queued:4,running:1,dispatching:0,queued_over_2m:2,expired_leases:0,review:5,review_without_api_receipt:3,oldest_queued_at:'2026-01-01T00:00:00Z'};
 const out=await handleOperator('/operator/pending','GET',{}, {query:async sql=>{queries.push(sql);return {rows:sql.startsWith('SELECT COUNT')?[summary]:Array.from({length:100},(_,id)=>({id,status:'completed'}))};}});
 assert.equal(out.requests.length,100);assert.equal(out.queueSummary.total,150);assert.equal(out.queueSummary.queued_over_2m,2);
 assert.equal(queries.length,2);assert.ok(queries.every(q=>q.startsWith('SELECT')));
 assert.doesNotMatch(queries[1],/LIMIT|message_text|reply_text|sender_id/);
 assert.match(queries[1],/lease_until<NOW\(\)/);assert.match(queries[1],/provider_id IS NULL/);
});
