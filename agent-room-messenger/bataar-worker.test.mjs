import test from 'node:test';
import assert from 'node:assert/strict';
import {graphClient,startBataarWorker} from './bataar-worker.mjs';
import {PAGE_ID} from './bataar-schedule.mjs';
test('adapter uses separate camp secret and never calls another Page feed',async()=>{
  const calls=[];const graph=graphClient({MOTHERLAND_PAGE_ACCESS_TOKEN:'camp-test',PAGE_ACCESS_TOKEN:'other-page-test'},async(url,options)=>{calls.push([url,options]);return {ok:true,json:async()=>({id:PAGE_ID+'_123'})};});
  await graph(PAGE_ID+'/feed',{message:'Test'});
  assert.equal(calls[0][1].headers.Authorization,'Bearer camp-test');
  assert.deepEqual(JSON.parse(calls[0][1].body),{message:'Test'});
  await assert.rejects(graph('1309261702280978/feed',{message:'wrong'}));
  await assert.rejects(graph(PAGE_ID+'/messages',{message:'no DMs'}));
  assert.equal(calls.length,1);
});
test('Meta failure is generic and never leaks a provider error or token',async()=>{
 const graph=graphClient({MOTHERLAND_PAGE_ACCESS_TOKEN:'secret'},async()=>({ok:false,json:async()=>({error:{message:'secret details'}})}));
 await assert.rejects(graph('me?fields=id'),e=>!e.message.includes('secret'));
});
test('worker disabled by default and no infrastructure touched',async()=>{
 const w=startBataarWorker({query(){throw Error('must not query')}},{env:{}});await w.done;assert.equal(w.state.status,'disabled');
});
test('activation requires a deliberate cutover time',async()=>{
 const w=startBataarWorker({query(){throw Error('must not query')}},{env:{BATAAR_WORKER_ENABLED:'true'}});await w.done;assert.equal(w.state.status,'cutover-not-configured');
});
