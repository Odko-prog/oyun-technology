import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareJobInputs,conversationHistory} from './context.mjs';
const job={id:'current',sender_id:'customer-A',created_at:'2026-10-28T00:00:00Z',attachment_types:[]};
const file=()=>{const bytes=Buffer.from('old verified file');return {name:'report.txt',mime:'text/plain',bytes,sha256:createHash('sha256').update(bytes).digest('hex'),request_id:'previous',source_created_at:'2026-10-27T23:00:00Z'};};
test('follow-up gets actual previous delivered bytes scoped to the same customer',async()=>{
 const queries=[];const r=await prepareJobInputs({query:async(sql,args)=>{queries.push({sql,args});return {rows:[file()]};}},job);
 assert.equal(Buffer.from(r.files['/input/previous-output-1-report.txt'],'base64').toString(),'old verified file');
 assert.equal(r.metadata[0].origin,'previous_output');assert.equal(r.metadata[0].sourceRequestId,'previous');
 const q=queries[0];assert.deepEqual(q.args,['customer-A','current',job.created_at]);assert.match(q.sql,/a.sender_id=\$1 AND r.sender_id=\$1/);assert.match(q.sql,/r.provider_id IS NOT NULL/);assert.match(q.sql,/a.expires_at>NOW\(\)/);
});
test('previous supplied input can resume work when no completed output exists',async()=>{
 const queries=[];const r=await prepareJobInputs({query:async(sql,args)=>{queries.push({sql,args});return {rows:sql.includes('FROM messenger_inputs a ')?[file()]:[]};}},job);
 assert.equal(r.metadata[0].origin,'previous_input');assert.ok(r.files['/input/previous-input-1-report.txt']);
 for(const q of queries){assert.equal(q.args[0],'customer-A');assert.match(q.sql,/r.created_at<\$3/);}
});
test('an unavailable new upload never silently falls back to an old file',async()=>{
 const queries=[];const r=await prepareJobInputs({query:async(sql)=>{queries.push(sql);return {rows:[]};}},{...job,attachment_types:['file'],attachment_refs:[]});
 assert.deepEqual(r.metadata,[]);assert.ok(!queries.some(q=>q.includes('messenger_artifacts')));
});
test('corrupt prior artifact and ambiguous over-limit sets fail closed',async()=>{
 await assert.rejects(()=>prepareJobInputs({query:async()=>({rows:[{...file(),bytes:Buffer.from('tampered')}]})},job));
 await assert.rejects(()=>prepareJobInputs({query:async()=>({rows:Array.from({length:9},file)})},job));
});
test('a newer uploaded file takes priority over an older delivered artifact',async()=>{
 const old={...file(),name:'old.txt',source_created_at:'2026-10-27T20:00:00Z'};
 const newer={...file(),name:'new.txt',source_created_at:'2026-10-27T23:00:00Z'};
 const r=await prepareJobInputs({query:async sql=>({rows:sql.includes('FROM messenger_inputs a ')?[newer]:[old]})},job);
 assert.equal(r.metadata[0].origin,'previous_input');assert.equal(r.metadata[0].originalName,'new.txt');
});
test('history includes scoped Page replies and deduplicates API echo receipts',async()=>{
 let query;await conversationHistory({query:async(sql,args)=>{query={sql,args};return {rows:[]};}},job);
 assert.deepEqual(query.args,[job.sender_id,job.id,job.created_at]);
 assert.match(query.sql,/e.sender_id=\$1/);assert.match(query.sql,/r.sender_id=\$1 AND r.provider_id=e.source_id/);
 assert.match(query.sql,/UNION ALL/);assert.match(query.sql,/NOT EXISTS/);
});
