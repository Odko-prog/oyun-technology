import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {metaAttachmentURL,publicIPv4,downloadAttachment,prepareInputs,inputMetadata} from './inputs.mjs';
test('only HTTPS Meta attachment hosts can enter the download broker',()=>{
 for(const url of ['http://x.fbcdn.net/a','https://x.fbcdn.net.evil.test/a','https://127.0.0.1/a','https://x.fbcdn.net:8080/a','https://user:secret@x.fbcdn.net/a','file:///etc/passwd'])assert.throws(()=>metaAttachmentURL(url));
 assert.equal(metaAttachmentURL('https://lookaside.fbsbx.com/attachment/?x=synthetic').hostname,'lookaside.fbsbx.com');
});
test('private, reserved and mapped addresses fail closed',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.1.1','100.64.1.1','198.18.0.1','203.0.113.9','::ffff:127.0.0.1','::1','0.0.0.0','255.255.255.255'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('8.8.8.8'),true);
});
function transport({body='hello',status=200,headers={},observe=()=>{}}={}){return (url,options,callback)=>{
 observe(url,options);const req=new EventEmitter();req.setTimeout=()=>{};
 req.destroy=err=>{req.emit('error',err);req.emit('close');};
 req.end=()=>{const res=Readable.from([Buffer.from(body)]);res.statusCode=status;res.headers={'content-type':'text/plain',...headers};res.on('close',()=>req.emit('close'));callback(res);};return req;
};}
const lookup=async()=>[{address:'8.8.8.8',family:4}];
test('download pins the checked DNS address and sends no service credentials',async()=>{
 const r=await downloadAttachment('https://x.fbcdn.net/a',{lookup,request:transport({observe:(u,o)=>{
  assert.equal(o.agent,false);assert.ok(!('Authorization' in o.headers));
  o.lookup('x.fbcdn.net',{},(err,ip,family)=>{assert.equal(err,null);assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
 }})});assert.equal(r.bytes.toString(),'hello');
});
test('rebinding, external redirects and oversized responses are rejected',async()=>{
 await assert.rejects(()=>downloadAttachment('https://x.fbcdn.net/a',{lookup:async()=>[{address:'127.0.0.1'}],request:()=>{throw Error('must not connect');}}));
 await assert.rejects(()=>downloadAttachment('https://x.fbcdn.net/a',{lookup,request:transport({status:302,headers:{location:'https://evil.test/a'}})}));
 await assert.rejects(()=>downloadAttachment('https://x.fbcdn.net/a',{lookup,maxBytes:3,request:transport({body:'toolarge'})}));
});
test('input persistence is one atomic operation scoped to original job and sender',async()=>{
 const queries=[];const pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};}};
 const r=await prepareInputs(pool,{id:'job-A',sender_id:'sender-A',attachment_refs:[{url:'https://x.fbcdn.net/a'}]},{download:async()=>({mime:'text/csv',bytes:Buffer.from('a,b\n1,2')})});
 const write=queries.find(q=>q.sql.startsWith('WITH inserted'));
 assert.deepEqual(write.args.slice(0,2),['job-A','sender-A']);assert.match(write.sql,/UPDATE messenger_requests/);
 assert.equal(r.metadata[0].textPreview,'a,b\n1,2');assert.ok(r.files['/input/attachment-1.csv']);
 assert.ok(!JSON.stringify(r).includes('fbcdn.net'));
});
test('a stored file is reusable only through the matching sender query and valid hash',async()=>{
 const bytes=Buffer.from('saved'),f={name:'attachment-1.txt',mime:'text/plain',bytes,sha256:createHash('sha256').update(bytes).digest('hex')};let read;
 const r=await prepareInputs({query:async(sql,args)=>{if(sql.startsWith('SELECT')){read={sql,args};return {rows:[f]};}return {rows:[]};}},{id:'job-A',sender_id:'sender-A',attachment_refs:[]});
 assert.match(read.sql,/sender_id=\$2/);assert.deepEqual(read.args,['job-A','sender-A']);assert.equal(r.metadata[0].textPreview,'saved');
 assert.equal(inputMetadata({...f,bytes:Buffer.from([0,255])}).textPreview,null);
});
test('Office MIME types preserve parser-readable extensions rather than becoming generic binary names',async()=>{
 for(const [suffix,ext] of [['wordprocessingml.document','docx'],['presentationml.presentation','pptx'],['spreadsheetml.sheet','xlsx']]){
  const r=await prepareInputs({query:async()=>({rows:[]})},{id:'job-A',sender_id:'sender-A',attachment_refs:[{url:'https://x.fbcdn.net/a'}]},{download:async()=>({mime:'application/vnd.openxmlformats-officedocument.'+suffix,bytes:Buffer.from([80,75,0,255])})});assert.equal(r.metadata[0].name,'attachment-1.'+ext);assert.equal(r.metadata[0].textPreview,null);
 }
});

