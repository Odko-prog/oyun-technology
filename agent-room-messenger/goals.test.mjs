import test from 'node:test';
import assert from 'node:assert/strict';
import {recordGoalStep,recordGoalDelivery} from './goals.mjs';
const job={id:'12345678-0000-4000-8000-123456789012',sender_id:'A',lease:'12345678-0000-4000-8000-123456789013',created_at:'2026-10-28T00:00:00Z'};
test('a continuation uses a DB-proven same-customer older root and current lease',async()=>{
 let query;const parent='12345678-0000-4000-8000-123456789014';
 const root=await recordGoalStep({query:async(sql,args)=>{query={sql,args};return {rows:[{goal_id:parent}]};}},job,{continues_request_id:parent,status:'completed',verification:'bytes checked'});
 assert.equal(root,parent);assert.deepEqual(query.args,[job.id,'A',job.lease,parent,job.created_at,'bytes checked']);
 assert.match(query.sql,/sender_id=\$2 AND created_at<\$5/);assert.match(query.sql,/lease_until>NOW\(\)/);assert.match(query.sql,/EXISTS\(SELECT 1 FROM parent\)/);assert.match(query.sql,/'prepared'/);
});
test('wrong-customer, missing parent or stale lease cannot prepare a send',async()=>{
 for(const reference of [null,'12345678-0000-4000-8000-123456789014'])await assert.rejects(recordGoalStep({query:async()=>({rows:[]})},job,{continues_request_id:reference,status:'completed'}),/ownership or lease/);
 await assert.rejects(recordGoalStep({query:async()=>{throw Error('must not query');}},job,{continues_request_id:'arbitrary',status:'completed'}),/Invalid continuation/);
});
test('goal delivery trusts the persisted provider receipt rather than a model claim',async()=>{
 let q;await recordGoalDelivery({query:async(sql,args)=>{q={sql,args};}},job,{sent:true},'completed');
 assert.match(q.sql,/provider_id IS NOT NULL/);assert.match(q.sql,/r\.sender_id=\$2/);assert.match(q.sql,/r\.lease=\$3/);assert.equal(q.args[3],'completed');
 await recordGoalDelivery({query:async(sql,args)=>{q={sql,args};}},job,{sent:false},'completed');assert.equal(q.args[3],'review');
});
