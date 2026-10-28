import test from 'node:test';
import assert from 'node:assert/strict';
import {openLocalConnection} from './connection.mjs';
const id='12345678-0000-4000-8000-123456789012',key='a'.repeat(64),code='b'.repeat(64),time=1700000000000;
const response=o=>new Response(JSON.stringify(o),{headers:{'content-type':'application/json'}});
test('local credential stays in RAM/header; fixed origin, no redirects and owner activation required',async()=>{
 const calls=[];let state='pending_page';
 const connection=await openLocalConnection({now:()=>time,fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/start'))return response({sessionId:id,deviceKey:key,pairingCode:code,pageId:'1309261702280978',expiresAt:time+600000});if(url.endsWith('/activate'))state='active';if(url.endsWith('/revoke'))return response({id,state:'revoked'});return response({id,pageId:'1309261702280978',state,expiresAt:time+600000});}});
 assert.ok(!JSON.stringify(connection).includes(key));assert.equal(connection.pairingMessage,'AGENT-CONNECT '+code);
 await connection.status();await assert.rejects(connection.activate({workspaceLabel:'Shop',confirmed:false}));await connection.activate({workspaceLabel:'Shop',confirmed:true});
 assert.equal(calls[1].options.headers.Authorization,'Bearer '+key);assert.ok(calls.every(c=>c.url.startsWith('https://agent-room-messenger-ingress.onrender.com/device/')&&!c.url.includes(key)&&c.options.redirect==='error'));
 await connection.revoke();await assert.rejects(connection.status(),/closed|unavailable/);
});
test('network errors never expose credentials; failed revoke still closes local connection',async()=>{
 let n=0;const c=await openLocalConnection({now:()=>time,fetchImpl:async()=>{if(n++===0)return response({sessionId:id,deviceKey:key,pairingCode:code,pageId:'1309261702280978',expiresAt:time+600000});throw Error('private '+key);}});
 await assert.rejects(c.revoke(),error=>!error.message.includes(key));await assert.rejects(c.status());
});
