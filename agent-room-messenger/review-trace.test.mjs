import test from 'node:test';import assert from 'node:assert/strict';import {reviewTrace} from './review-trace.mjs';
test('review trace counts fragmented completed searches without retaining event contents',()=>{
 const t=reviewTrace();t.consume('{"type":"item.com');t.consume('pleted","item":{"type":"web_search","query":"PRIVATE"}}\n');
 t.consume('{"type":"item.started","item":{"type":"web_search"}}\ninvalid\n');
 assert.deepEqual(t.evidence(),{webSearchCompleted:1});assert.ok(!JSON.stringify(t).includes('PRIVATE'));
});
test('oversized event is discarded and next bounded event is counted',()=>{
 const t=reviewTrace();t.consume('x'.repeat(500001));t.consume('\n{"type":"item.completed","item":{"type":"web_search"}}\n');assert.equal(t.evidence().webSearchCompleted,1);
});
