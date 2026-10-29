import test from 'node:test';
import assert from 'node:assert/strict';
import {presentJobStatus,readOwnedJobStatus,priorJobStatuses,ownerJobNotice} from './job-status.mjs';
import {handleOperator} from './operator.mjs';
test('existing owner notice conflict stops before provider access',async()=>{
 const previous=process.env.OWNER_PSID;process.env.OWNER_PSID='123456789';
 try{
  let calls=0;
  const pool={query:async(sql)=>{calls++;if(sql.startsWith('SELECT sender_id,status,provider_id'))return {rowCount:1,rows:[{sender_id:'987654321',status:'completed',provider_id:'fixture'}]};assert.match(sql,/ON CONFLICT DO NOTHING/);return {rowCount:0,rows:[]};}};
  assert.deepEqual(await handleOperator('/operator/owner-notify','POST',{id:'00000000-0000-0000-0000-000000000001'},pool),{skipped:'already attempted'});
  assert.equal(calls,2);
 }finally{if(previous===undefined)delete process.env.OWNER_PSID;else process.env.OWNER_PSID=previous;}
});
test('owner notice reflects durable outcome rather than claiming generation is still starting',()=>{
 const id='00000000-0000-0000-0000-000000000001';
 assert.match(ownerJobNotice(id,{status:'completed',provider_id:'private-receipt'}),/Үр дүнг илгээсэн/);
 for(const request of [{status:'completed'},{status:'review',provider_id:'private-receipt'},{status:'dispatching'}]){
  const text=ownerJobNotice(id,request);assert.ok(!text.includes('Үр дүнг илгээсэн'));assert.ok(!text.includes('private-receipt'));
 }
 assert.match(ownerJobNotice(id,{status:'awaiting_customer',provider_id:'private-receipt'}),/нэмэлт мэдээлэл эсвэл зөвшөөрөл/);
});
test('completion requires persisted provider receipt, not status alone',()=>{
  assert.equal(presentJobStatus({status:'completed'}).state,'review');
  assert.equal(presentJobStatus({status:'completed',provider_id:'fixture'}).state,'completed');
});
test('worker context exposes bounded prior own statuses without provider identifiers',async()=>{
 let query;
 const job={id:'current',sender_id:'persisted-owner',created_at:'2026-10-28T00:00:00Z'};
 const pool={query:async(sql,args)=>{query={sql,args};return {rows:[{id:'prior',status:'completed',provider_id:'private-receipt',message_text:'private'}]};}};
 const result=await priorJobStatuses(pool,job);
 assert.deepEqual(query.args,[job.sender_id,job.id,job.created_at]);
 assert.match(query.sql,/sender_id=\$1 AND id<>\$2 AND created_at<\$3/);
 assert.match(query.sql,/LIMIT 8/);
 assert.deepEqual(Object.keys(result[0]),['request_id','state','label','terminal']);
 assert.equal(result[0].state,'completed');
});
test('actual received queue state is shown as queued',()=>assert.equal(presentJobStatus({status:'received'}).state,'queued'));
test('wrong Page and malformed identity cannot query storage',async()=>{
 const pool={query:()=>{throw Error('must not query');}};
 assert.equal(await readOwnedJobStatus(pool,'00000000-0000-0000-0000-000000000001',{pageId:'440088839501409',senderId:'123456'}),null);
 assert.equal(await readOwnedJobStatus(pool,'bad',{pageId:'1309261702280978',senderId:'123456'}),null);
});
test('owned lookup binds sender in SQL and hides unknown request',async()=>{
 let args;
 const pool={query:async(sql,params)=>{args={sql,params};return {rows:[]};}};
 const id='00000000-0000-0000-0000-000000000001';
 assert.equal(await readOwnedJobStatus(pool,id,{pageId:'1309261702280978',senderId:'123456'}),null);
 assert.match(args.sql,/id=\$1 AND sender_id=\$2/);
 assert.deepEqual(args.params,[id,'123456']);
});
test('uncertain and in-flight delivery cannot appear completed',()=>{
  assert.equal(presentJobStatus({status:'dispatching',provider_id:'fixture'}).state,'delivering');
  assert.equal(presentJobStatus({status:'review',provider_id:'fixture'}).state,'review');
  assert.equal(presentJobStatus({status:'unknown'}).state,'review');
});
test('presentation returns only allowlisted public status fields',()=>{
  const result=presentJobStatus({status:'processing',sender_id:'private',body:'private'});
  assert.deepEqual(Object.keys(result),['state','label','terminal']);
  assert.equal(result.state,'running');
});
test('malformed or blank provider receipt never implies delivery',()=>{
 for(const provider_id of ['', '   ', true, 123, {}, []])assert.equal(presentJobStatus({status:'completed',provider_id}).state,'review');
});
