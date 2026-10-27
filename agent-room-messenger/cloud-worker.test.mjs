import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateReply,childEnvironment,processRequest,startCloudWorker} from './cloud-worker.mjs';
test('rejects empty, oversized and unexpected reply states',()=>{
 for(const v of [{reply:'',status:'review'},{reply:'x'.repeat(1801),status:'review'},{reply:'done',status:'unknown'},null])assert.throws(()=>validateReply(v));
 assert.equal(validateReply({reply:'Туршилт',status:'awaiting_customer'}).reply,'Туршилт');
});
test('model process never inherits operational credentials',()=>{
 const env=childEnvironment({PATH:'/bin',CODEX_HOME:'/data/codex',DATABASE_URL:'secret',PAGE_ACCESS_TOKEN:'secret',OPERATOR_TOKEN:'secret',OPENAI_API_KEY:'secret'});
 assert.deepEqual(env,{PATH:'/bin',CODEX_HOME:'/data/codex'});
});
const job={id:'job-1',sender_id:'sender-A',lease:'lease-1',created_at:'2026-10-27T00:00:00Z',message_text:'fixture',attachment_types:[]};
test('history is scoped to sender, excludes current request and requires successful send',async()=>{
 let observed;
 const pool={async query(sql,args){observed={sql,args};return {rows:[]};}};
 const calls=[];const handle=async(route)=>{calls.push(route);return {sent:true};};
 const result=await processRequest(pool,handle,job,async()=>({reply:'Тест',status:'awaiting_customer'}));
 assert.match(observed.sql,/sender_id=\$1/);assert.match(observed.sql,/provider_id IS NOT NULL/);assert.equal(observed.args[0],'sender-A');
 assert.equal(result.sent,true);assert.deepEqual(calls,['/operator/result','/operator/owner-notify']);
});
test('uncertain delivery is attempted once without retry or notification',async()=>{
 const calls=[];const result=await processRequest({query:async()=>({rows:[]})},async(route)=>{calls.push(route);return {sent:false,needsReview:true};},job,async()=>({reply:'Тест',status:'review'}));
 assert.equal(result.review,true);assert.deepEqual(calls,['/operator/result']);
});
test('model failure marks only matching processing lease for review without sending',async()=>{
 const queries=[];const pool={async query(sql,args){queries.push({sql,args});return {rows:[]};}};
 const result=await processRequest(pool,()=>{throw Error('must not send');},job,async()=>{throw Error('model failed');});
 assert.equal(result.review,true);assert.match(queries[1].sql,/status='processing'/);assert.deepEqual(queries[1].args,['job-1','lease-1']);
});
test('disabled cloud worker cannot claim or send',async()=>{
 const worker=startCloudWorker({},()=>{throw Error('must not run');},{env:{CLOUD_WORKER_ENABLED:'false'}});
 await worker.done;assert.equal(worker.state.status,'disabled');await worker.stop();
});

test('completed text work is delivered once and retains completion status',async()=>{
 const calls=[];const pool={query:async()=>({rows:[]})};
 const result=await processRequest(pool,async(route,method,body)=>{calls.push({route,body});return {sent:true};},job,async()=>({reply:'Prepared translation',status:'completed'}));
 assert.equal(result.sent,true);assert.equal(calls[0].body.status,'completed');assert.equal(calls[0].body.reply,'Prepared translation');assert.equal(calls.filter(c=>c.route==='/operator/result').length,1);
});
