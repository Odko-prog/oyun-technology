import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateReply,childEnvironment,processRequest,startCloudWorker,executorConfig} from './cloud-worker.mjs';
import {createHash} from 'node:crypto';
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

test('verified file is bound to request and sender before one CAS delivery',async()=>{
 const bytes=Buffer.from('item,total\napples,91');const queries=[],calls=[];
 const pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};}};
 const result=await processRequest(pool,async(route,method,body)=>{calls.push({route,body});return {sent:true};},job,async()=>({reply:'Файл бэлэн.',status:'completed',artifacts:[{name:'result.csv',mime:'application/octet-stream',bytes,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
 assert.equal(result.sent,true);
 const insert=queries.find(q=>q.sql.startsWith('INSERT INTO messenger_artifacts'));
 assert.equal(insert.args[1],job.id);assert.equal(insert.args[2],job.sender_id);assert.deepEqual(insert.args[5],bytes);
 assert.equal(calls.filter(c=>c.route==='/operator/result').length,1);
 assert.match(calls[0].body.reply,/https:\/\/agent-room-messenger-ingress\.onrender\.com\/artifact\/[a-f0-9]{64}/);
 assert.ok(calls[0].body.reply.length<=1800);
});

test('tampered file cannot be sent as completed work',async()=>{
 let sends=0;
 const result=await processRequest({query:async()=>({rows:[]})},async()=>{sends++;return {sent:true};},job,async()=>({reply:'done',status:'completed',artifacts:[{name:'result.txt',mime:'text/plain',bytes:Buffer.from('changed'),sha256:'0'.repeat(64)}]}));
 assert.equal(sends,0);assert.equal(result.review,true);
});
test('executor uses actual automatic review and scoped output directory',()=>{
 const c=executorConfig('/tmp/agent-room-fixture');
 assert.ok(c.includes('approval_policy="on-request"'));assert.ok(c.includes('approvals_reviewer="auto_review"'));
 assert.ok(c.some(x=>x.includes('agent-room-fixture')&&x.includes('outputs')));
 assert.ok(!c.some(x=>/danger-full-access|bypass|approval_policy="never"/.test(x)));
});
