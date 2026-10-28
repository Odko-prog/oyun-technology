import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeDeviceArtifacts,dispatchOneDeviceResult} from './device-tasks.mjs';
test('device files require actual bounded canonical bytes, matching hash and safe unique names',()=>{
 const bytes=Buffer.from('actual result'),f={name:'result.csv',mime:'text/csv',base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
 assert.deepEqual(decodeDeviceArtifacts([f])[0].bytes,bytes);
 for(const files of [[{...f,name:'../private'}],[{...f,sha256:'0'.repeat(64)}],[f,f],[{...f,base64:f.base64+'\n'}],[{...f,mime:'text/html; unsafe'}]])assert.throws(()=>decodeDeviceArtifacts(files));
});
function deliveryFixture({failSend=false,failCommit=false,wrongCustomer=false}={}){
 let state='pending',sends=0;const queries=[];
 const row={id:'task',session_id:'device',request_id:'request',record:{senderId:'A'},delivery_text:'Verified result'};
 const db={async query(sql,args){queries.push(sql);if(sql==='COMMIT'&&failCommit)throw Error('DB commit lost');if(sql.includes('FROM messenger_devices'))return {rows:[{record:{state:'active',expiresAt:Date.now()+60000,senderId:'A'}}]};if(sql.includes('SELECT sender_id'))return {rows:[{sender_id:wrongCustomer?'B':'A'}]};if(sql.includes("delivery_state='sent'"))state='sent';return {rows:[]};},release(){}};
 const pool={connect:async()=>db,async query(sql,args){queries.push(sql);if(sql.startsWith('WITH next')){if(state!=='pending')return {rows:[]};state='dispatching';return {rows:[row]};}if(sql.includes("delivery_state='review'"))state='review';return {rows:[]};}};
 const send=async(recipient,text)=>{sends++;assert.equal(recipient,'A');assert.equal(text,'Verified result');if(failSend)throw Error('Provider outcome uncertain');return 'provider-receipt';};
 return {pool,send,get state(){return state;},get sends(){return sends;},queries};
}
test('successful device result uses persisted recipient and records one provider receipt',async()=>{
 const f=deliveryFixture();assert.equal((await dispatchOneDeviceResult(f.pool,f.send)).sent,true);assert.equal(f.state,'sent');assert.equal(await dispatchOneDeviceResult(f.pool,f.send),null);assert.equal(f.sends,1);
 assert.match(f.queries.find(x=>x.startsWith('WITH next')),/delivery_state='dispatching'/);assert.match(f.queries.find(x=>x.startsWith('SELECT record FROM messenger_devices')),/FOR UPDATE/);
});
test('uncertain provider or lost DB commit is held for review and never retried',async()=>{
 for(const options of [{failSend:true},{failCommit:true}]){const f=deliveryFixture(options);assert.equal((await dispatchOneDeviceResult(f.pool,f.send)).review,true);assert.equal(f.state,'review');assert.equal(await dispatchOneDeviceResult(f.pool,f.send),null);assert.equal(f.sends,1);}
});
test('mismatched request customer prevents any provider call',async()=>{
 const f=deliveryFixture({wrongCustomer:true});assert.equal((await dispatchOneDeviceResult(f.pool,f.send)).review,true);assert.equal(f.sends,0);assert.equal(f.state,'review');
});
