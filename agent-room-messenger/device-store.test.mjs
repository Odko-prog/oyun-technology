import test from 'node:test';
import assert from 'node:assert/strict';
import {handleDeviceRequest,startStoredDevice,bindStoredDeviceFromSignedPage} from './device-store.mjs';
test('device HTTP feature is disabled by default without touching storage',async()=>{
 const pool={connect(){throw Error('must not connect');}};
 assert.equal((await handleDeviceRequest('/device/start','POST',{},null,pool)).status,503);
 assert.equal(await handleDeviceRequest('/unrelated','GET',{},null,pool),null);
});
test('malformed or missing local device credentials never reach storage',async()=>{
 const pool={connect(){throw Error('must not connect');}};
 for(const header of [null,'Bearer password','Basic '+ 'a'.repeat(64)])assert.equal((await handleDeviceRequest('/device/12345678-0000-4000-8000-123456789012/status','GET',{},header,pool,{enabled:true})).status,404);
 assert.equal(await bindStoredDeviceFromSignedPage({query(){throw Error('must not query');}},{pageId:'other',senderId:'123',text:'AGENT-CONNECT '+'a'.repeat(64)}),false);
});
test('anonymous session capacity is serialized and rolls back without creating a credential',async()=>{
 const calls=[];let released=false;
 const db={query:async(sql)=>{calls.push(sql);return {rows:sql.includes('COUNT(*)')?[{count:100}]:[]};},release(){released=true;}};
 await assert.rejects(startStoredDevice({connect:async()=>db}),/capacity/);
 assert.match(calls[1],/pg_advisory_xact_lock/);assert.equal(calls.at(-1),'ROLLBACK');assert.ok(!calls.some(q=>q.startsWith('INSERT')));assert.equal(released,true);
});
