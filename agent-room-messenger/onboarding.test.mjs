import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {onboardingAssets,serveOnboarding} from './onboarding.mjs';
test('public onboarding and downloadable package agree on exact bytes and do not create connections',async()=>{
 const assets=onboardingAssets();
 const server=http.createServer((req,res)=>{if(!serveOnboarding(req.url,res,assets)){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const base=`http://127.0.0.1:${server.address().port}`;
  const page=await fetch(base+'/device-onboarding');const html=await page.text();
  assert.equal(page.status,200);assert.match(html,/Messenger-тэй төхөөрөмжийг холбохгүй/);assert.ok(html.includes(assets.manifest.sha256));assert.doesNotMatch(html,/<script|<form|<input/i);
  const file=await fetch(base+'/downloads/agent-room-local-agent.zip');const bytes=Buffer.from(await file.arrayBuffer());
  assert.equal(file.headers.get('content-disposition'),'attachment; filename="agent-room-local-agent.zip"');assert.equal(file.headers.get('x-content-type-options'),'nosniff');assert.equal(bytes.length,assets.manifest.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),assets.manifest.sha256);assert.equal(bytes.readUInt32LE(0),0x04034b50);
  assert.equal((await fetch(base+'/downloads/../secret')).status,404);
 }finally{await new Promise(r=>server.close(r));}
});
