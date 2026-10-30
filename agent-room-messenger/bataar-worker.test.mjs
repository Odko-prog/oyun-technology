import test from 'node:test';
import assert from 'node:assert/strict';
import {graphClient,startBataarWorker,CAMP_PHOTO_URL} from './bataar-worker.mjs';
test('photo adapter only publishes exact owner-approved asset to camp Page',async()=>{const calls=[];const g=graphClient({MOTHERLAND_PAGE_ACCESS_TOKEN:'test'},async(u,o)=>{calls.push(JSON.parse(o.body));return {ok:true,json:async()=>({post_id:PAGE_ID+'_1'})};});await g(PAGE_ID+'/photos',{message:'Эзний бичлэгийн кадр',photoUrl:CAMP_PHOTO_URL});assert.deepEqual(calls[0],{caption:'Эзний бичлэгийн кадр',url:CAMP_PHOTO_URL});await assert.rejects(g(PAGE_ID+'/photos',{message:'x',photoUrl:'https://example.com/leopard.jpg'}));await assert.rejects(g('1309261702280978/photos',{message:'x',photoUrl:CAMP_PHOTO_URL}));assert.equal(calls.length,1);});
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