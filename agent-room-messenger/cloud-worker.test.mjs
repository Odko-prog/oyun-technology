import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateReply,childEnvironment,processRequest as actualProcessRequest,startCloudWorker,executorConfig,generateReply,failureMetadata} from './cloud-worker.mjs';
import {createHash} from 'node:crypto';
async function processRequest(pool, ...args){
 const wrapped={query:async(sql,params)=>{
  if(sql.includes('INSERT INTO messenger_goal_steps'))return {rows:[{goal_id:params[0]}]};
  if(sql.startsWith('UPDATE messenger_goal_steps'))return {rows:[]};
  return pool.query(sql,params);
 }};
 return actualProcessRequest(wrapped,...args);
}
test('rejects empty, oversized and unexpected reply states',()=>{
 for(const v of [{reply:'',status:'review'},{reply:'x'.repeat(1801),status:'review'},{reply:'done',status:'unknown'},null])assert.throws(()=>validateReply(v));
 assert.equal(validateReply({reply:'Туршилт',status:'awaiting_customer'}).reply,'Туршилт');
});
test('model process never inherits operational credentials',()=>{
 const env=childEnvironment({PATH:'/bin',CODEX_HOME:'/data/codex',DATABASE_URL:'secret',PAGE_ACCESS_TOKEN:'secret',OPERATOR_TOKEN:'secret',OPENAI_API_KEY:'secret'});
 assert.deepEqual(env,{PATH:'/bin',CODEX_HOME:'/data/codex'});
});
const job={id:'job-1',sender_id:'sender-A',lease:'lease-1',created_at:'2026-10-27T00:00:00Z',message_text:'fixture',attachment_types:[]};
test('invented or disabled customer device cannot be queued or acknowledged',async()=>{
 for(const enabled of ['false','true']){
  let sends=0;const result=await processRequest({query:async()=>({rows:[]})},async()=>{sends++;return {sent:true};},job,async()=>({reply:'Pending local approval',status:'awaiting_customer',device_task:{session_id:'12345678-0000-4000-8000-123456789012',goal:'Work'}}),{env:{DEVICE_BRIDGE_ENABLED:enabled}});
  assert.equal(result.review,true);assert.equal(sends,0);
 }
});
test('a delivered review reply still reports that the underlying work needs review',async()=>{
 const result=await processRequest({query:async()=>({rows:[]})},async()=>({sent:true}),job,async()=>({reply:'Specific capability missing',status:'review'}));assert.equal(result.sent,true);assert.equal(result.review,true);
});
test('verified Page pairing never forwards the pairing code as model instructions',async()=>{
 let observed;const pool={query:async()=>({rows:[]})};const key='a'.repeat(64);
 await processRequest(pool,async()=>({sent:true}),{...job,device_pairing:true,message_text:'AGENT-CONNECT '+key},async input=>{observed=input;return {reply:'Local owner confirmation is still required.',status:'awaiting_customer'};});
 assert.deepEqual(observed.device_pairing,{matched:true,state:'pending_owner'});assert.ok(!JSON.stringify(observed).includes(key));assert.equal(observed.text,'Компьютер холбох хүсэлт');
});
test('unproven continuation cannot reach the real delivery adapter',async()=>{
 let sends=0;
 const r=await actualProcessRequest({query:async()=>({rows:[]})},async()=>{sends++;return {sent:true};},job,async()=>({reply:'Done',status:'completed',continues_request_id:'12345678-0000-4000-8000-123456789014'}));
 assert.equal(sends,0);assert.equal(r.review,true);
});
test('history is scoped to sender, excludes current request and requires successful send',async()=>{
 let observed;
 const pool={async query(sql,args){if(sql.includes(' AS customer'))observed={sql,args};return {rows:[]};}};
 const calls=[];const handle=async(route)=>{calls.push(route);return {sent:true};};
 const result=await processRequest(pool,handle,job,async()=>({reply:'Тест',status:'awaiting_customer'}));
 assert.match(observed.sql,/sender_id=\$1/);assert.match(observed.sql,/provider_id IS NOT NULL/);assert.equal(observed.args[0],'sender-A');
 assert.equal(result.sent,true);assert.deepEqual(calls,['/operator/result','/operator/owner-notify']);
});
test('uncertain delivery is attempted once without retry or notification',async()=>{
 const calls=[];const result=await processRequest({query:async()=>({rows:[]})},async(route)=>{calls.push(route);return {sent:false,needsReview:true};},job,async()=>({reply:'Тест',status:'review'}));
 assert.equal(result.review,true);assert.deepEqual(calls,['/operator/result']);
});
test('failure metadata never exposes exception text or untrusted codes and preserves bounded exit facts',()=>{
 const secret='private customer text token=https://secret.invalid';
 assert.deepEqual(failureMetadata({code:secret,message:secret,stderr:secret}),{failureCode:'UNCLASSIFIED'});
 assert.deepEqual(failureMetadata({code:'AI_PROCESS_EXIT',exitCode:137,exitSignal:'SIGKILL',message:secret}),{failureCode:'AI_PROCESS_EXIT',exitCode:137,exitSignal:'SIGKILL'});
 assert.deepEqual(failureMetadata({code:'AI_PROCESS_EXIT',exitCode:999,exitSignal:secret}),{failureCode:'AI_PROCESS_EXIT'});
});

test('typed model timeout stays held for review without a send or circuit-breaker downgrade',async()=>{
 let sends=0;
 const result=await processRequest({query:async()=>({rows:[]})},async()=>{sends++;},job,async()=>{throw Object.assign(Error('private details'),{code:'AI_TIMEOUT'});});
 assert.equal(result.failureCode,'AI_TIMEOUT');assert.equal(result.generationFailed,true);assert.equal(result.review,true);assert.equal(sends,0);assert.ok(!JSON.stringify(result).includes('private details'));
});

test('model failure marks only matching processing lease for review without sending',async()=>{
 const queries=[];const pool={async query(sql,args){queries.push({sql,args});return {rows:[]};}};
 const result=await processRequest(pool,()=>{throw Error('must not send');},job,async()=>{throw Error('model failed');});
 assert.equal(result.review,true);assert.equal(result.generationFailed,true);assert.equal(result.failureStage,'generation');const review=queries.find(q=>q.sql.startsWith('UPDATE messenger_requests'));assert.match(review.sql,/status='processing'/);assert.deepEqual(review.args,['job-1','lease-1']);
});

test('corrupt prior input does not stop the worker from delivering the next customer job',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'agent-room-worker-test-'));
 let worker,claims=0,generated=0;const delivered=[],reviewed=[];
 try{
  await writeFile(join(dir,'auth.json'),'{}'); // Access fixture only; no real account/model.
  const pool={async query(sql,args){
   if(sql.includes('INSERT INTO messenger_goal_steps'))return {rows:[{goal_id:args[0]}]};
   if(sql.startsWith('UPDATE messenger_requests'))reviewed.push(args[0]);
   if(sql.startsWith('SELECT a.name')&&sql.includes('FROM messenger_artifacts')&&args[1]==='bad-input')return {rows:[{name:'old.txt',mime:'text/plain',bytes:Buffer.from('tampered'),sha256:'0'.repeat(64)}]};
   return {rows:[]};
  },async connect(){return {query:async()=>({rows:[{acquired:true}]}),release(){}};}};
  const handle=async route=>{
   if(route==='/operator/claim'){claims++;return claims<=2?{request:{...job,id:claims===1?'bad-input':'next-job'}}:{};}
   if(route==='/operator/result'){delivered.push('next-job');return {sent:true};}
   return {};
  };
  worker=startCloudWorker(pool,handle,{env:{CLOUD_WORKER_ENABLED:'true',CODEX_HOME:dir},generate:async()=>{generated++;return {reply:'Verified text',status:'completed'};}});
  const deadline=Date.now()+3000;
  while(claims<3&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.ok(claims>=3);assert.deepEqual(reviewed,['bad-input']);assert.equal(generated,1);assert.deepEqual(delivered,['next-job']);assert.equal(worker.state.lastResult.sent,true);
 }finally{await worker?.stop();await rm(dir,{recursive:true,force:true});}
});

test('invalid output and uncertain adapter failure stay isolated without delivery retry',async()=>{
 let sends=0;const pool={query:async()=>({rows:[]})};
 const invalid=await processRequest(pool,async()=>{sends++;},job,async()=>({reply:'',status:'completed'}));
 assert.equal(invalid.failureStage,'verification');assert.equal(invalid.generationFailed,false);assert.equal(sends,0);
 const uncertain=await processRequest(pool,async()=>{sends++;throw Error('uncertain');},job,async()=>({reply:'Done',status:'completed'}));
 assert.equal(uncertain.failureStage,'delivery');assert.equal(uncertain.review,true);assert.equal(uncertain.generationFailed,false);assert.equal(sends,1);
 const badFile=await processRequest(pool,async()=>{sends++;},job,async()=>{const error=Error('Invalid generated Office package');error.code='AGENT_OUTPUT_INVALID';throw error;});
 assert.equal(badFile.failureStage,'verification');assert.equal(badFile.generationFailed,false);assert.equal(sends,1);
 const badImage=await processRequest(pool,async()=>{sends++;},job,async()=>{const error=Error('Invalid image');error.code='AGENT_INPUT_INVALID';throw error;});assert.equal(badImage.failureStage,'preparation');assert.equal(badImage.generationFailed,false);assert.equal(sends,1);
});
test('invalid image is rejected before launching any model process',async()=>{
 await assert.rejects(generateReply({input_files:[{name:'missing.png',mime:'image/png'}],input_file_bytes:{}},{env:{CODEX_BIN:'must-not-execute'}}),e=>e.code==='AGENT_INPUT_INVALID');
});
test('disabled cloud worker cannot claim or send',async()=>{
 const worker=startCloudWorker({},()=>{throw Error('must not run');},{env:{CLOUD_WORKER_ENABLED:'false'}});
 await worker.done;assert.equal(worker.state.status,'disabled');await worker.stop();
});

test('completed text work is delivered once and retains completion status',async()=>{
 const calls=[];const pool={query:async()=>({rows:[]})};
 const result=await processRequest(pool,async(route,method,body)=>{calls.push({route,body});return {sent:true};},job,async()=>({reply:'Prepared translation',status:'completed'}));
 assert.equal(result.sent,true);assert.equal(calls[0].body.status,'completed');assert.equal(calls[0].body.reply,'Prepared translation');assert.equal(calls.filter(c=>c.route==='/operator/result').length,1);
});

test('verified file is bound to request and sender before one CAS delivery',async()=>{
 const bytes=Buffer.from('item,total\napples,91');const queries=[],calls=[];
 const pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};}};
 const result=await processRequest(pool,async(route,method,body)=>{calls.push({route,body});return {sent:true};},job,async()=>({reply:'Файл бэлэн.',status:'completed',artifacts:[{name:'result.csv',mime:'application/octet-stream',bytes,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
 assert.equal(result.sent,true);
 const insert=queries.find(q=>q.sql.startsWith('INSERT INTO messenger_artifacts'));
 assert.equal(insert.args[1],job.id);assert.equal(insert.args[2],job.sender_id);assert.deepEqual(insert.args[5],bytes);
 assert.equal(calls.filter(c=>c.route==='/operator/result').length,1);
 assert.match(calls[0].body.reply,/https:\/\/agent-room-messenger-ingress\.onrender\.com\/artifact\/[a-f0-9]{64}/);
 assert.ok(calls[0].body.reply.length<=1800);
});

test('tampered file cannot be sent as completed work',async()=>{
 let sends=0;
 const result=await processRequest({query:async()=>({rows:[]})},async()=>{sends++;return {sent:true};},job,async()=>({reply:'done',status:'completed',artifacts:[{name:'result.txt',mime:'text/plain',bytes:Buffer.from('changed'),sha256:'0'.repeat(64)}]}));
 assert.equal(sends,0);assert.equal(result.review,true);
});
test('executor uses actual automatic review and scoped output directory',()=>{
 const c=executorConfig('/tmp/agent-room-fixture');
 assert.ok(c.includes('approval_policy="on-request"'));assert.ok(c.includes('approvals_reviewer="auto_review"'));
 assert.ok(c.some(x=>x.includes('agent-room-fixture')&&x.includes('outputs')));
 assert.ok(!c.some(x=>/danger-full-access|bypass|approval_policy="never"/.test(x)));
});
test('attachment bytes reach only this job while signed CDN URLs stay out of model input',async()=>{
 const attached={...job,attachment_types:['file'],attachment_refs:[{type:'file',url:'https://x.fbcdn.net/private?synthetic=secret'}]};
 const pool={query:async()=>({rows:[]})};let observed;
 const result=await processRequest(pool,async()=>({sent:true}),attached,async input=>{observed=input;return {reply:'Processed supplied input',status:'completed'};},{download:async()=>({mime:'text/csv',bytes:Buffer.from('item,qty\napples,7')})});
 assert.equal(result.sent,true);assert.ok(observed.input_file_bytes['/input/attachment-1.csv']);
 assert.equal(observed.input_files[0].textPreview,'item,qty\napples,7');
 assert.ok(!JSON.stringify(observed).includes('fbcdn.net'));assert.ok(!JSON.stringify(observed).includes('synthetic=secret'));
});

test('model receives own prior status without provider receipt or private body',async()=>{
 let observed;
 const pool={query:async sql=>({rows:sql.startsWith('SELECT id,status,provider_id')?[{id:'prior',status:'processing',provider_id:null,message_text:'private'}]:[]})};
 await processRequest(pool,async()=>({sent:true}),job,async input=>{observed=input;return {reply:'Тест',status:'awaiting_customer'};});
 assert.deepEqual(observed.prior_statuses,[{request_id:'prior',state:'running',label:'Ажлыг гүйцэтгэж байна',terminal:false}]);
});
test('status storage failure holds preparation for review without generation or send',async()=>{
 let generated=0,sent=0;
 const pool={query:async sql=>{if(sql.startsWith('SELECT id,status,provider_id'))throw Error('storage');return {rows:[]};}};
 const result=await processRequest(pool,async()=>{sent++;},job,async()=>{generated++;});
 assert.equal(result.failureStage,'preparation');assert.equal(result.review,true);assert.equal(generated,0);assert.equal(sent,0);
});
test('successful empty poll clears transient queue error',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'agent-room-recovery-test-'));let worker,claims=0;
 try{
  await writeFile(join(dir,'auth.json'),'{}');
  const pool={connect:async()=>({query:async()=>({rows:[{acquired:true}]}),release(){}})};
  worker=startCloudWorker(pool,async()=>{if(++claims===1)throw Error('synthetic transient');return {};},{env:{CLOUD_WORKER_ENABLED:'true',CODEX_HOME:dir},generate:async()=>{throw Error('must not generate');}});
  const deadline=Date.now()+33000;
  while(claims<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  assert.ok(claims>=2);assert.equal(worker.state.status,'ready');assert.ok(worker.state.lastPoll);
 }finally{await worker?.stop();await rm(dir,{recursive:true,force:true});}
});

async function timeoutIsolationFixture(codes){
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'agent-room-timeout-isolation-'));
 let worker,generated=0,sends=0,claims=0;const reviewed=[];
 try{
  await writeFile(join(dir,'auth.json'),'{}');
  const pool={connect:async()=>({query:async()=>({rows:[{acquired:true}]}),release(){}}),query:async(sql,args)=>{
   if(sql.startsWith('UPDATE messenger_requests'))reviewed.push(args[0]);
   return {rows:sql.includes('INSERT INTO messenger_goal_steps')?[{goal_id:args[0]}]:[]};
  }};
  worker=startCloudWorker(pool,async(route)=>{
   if(route==='/operator/claim'){const n=claims++;return n<codes.length?{request:{...job,id:'isolation-'+n}}:{};}
   if(route==='/operator/result'){sends++;return {sent:true};}return {};
  },{env:{CLOUD_WORKER_ENABLED:'true',CODEX_HOME:dir},generate:async()=>{
   const code=codes[generated++];if(code)throw Object.assign(Error('fixture'),{code});
   return {reply:'Fixture result',status:'completed'};
  }});
  const until=Date.now()+3000;
  while(Date.now()<until&&generated<codes.length&&worker.state.status!=='generation-error-review-required')await new Promise(r=>setTimeout(r,5));
  await worker.stop();
  return {generated,sends,reviewed,lastFailure:worker.state.lastFailure,consecutiveTimeouts:worker.state.consecutiveTimeouts,claims};
 }finally{await worker?.stop();await rm(dir,{recursive:true,force:true});}
}
test('timeout isolation continues another job without retrying or sending failed request',async()=>{
 const r=await timeoutIsolationFixture(['AI_TIMEOUT',null]);
 assert.equal(r.generated,2);assert.equal(r.sends,1);assert.deepEqual(r.reviewed,['isolation-0']);
 assert.equal(r.lastFailure.failureCode,'AI_TIMEOUT');assert.equal(r.consecutiveTimeouts,0);
});
test('timeout isolation retains auth approval and unclassified generation breaker',async()=>{
 const r=await timeoutIsolationFixture(['UNCLASSIFIED',null]);assert.equal(r.generated,1);assert.equal(r.sends,0);
});
test('timeout isolation stops after three consecutive timeouts',async()=>{
 const r=await timeoutIsolationFixture(['AI_TIMEOUT','AI_TIMEOUT','AI_TIMEOUT',null]);
 assert.equal(r.generated,3);assert.equal(r.sends,0);assert.equal(r.consecutiveTimeouts,3);
 assert.deepEqual(r.reviewed,['isolation-0','isolation-1','isolation-2']);
});

test('committed inbound sensor wakes an idle worker without a second dispatcher or model call',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'agent-room-wake-'));let worker,claims=0;
 try{
  await writeFile(join(dir,'auth.json'),'{}');
  worker=startCloudWorker({connect:async()=>({query:async()=>({rows:[{acquired:true}]}),release(){}})},async()=>{claims++;return {};},{env:{CLOUD_WORKER_ENABLED:'true',CODEX_HOME:dir},generate:async()=>{throw Error('no model');}});
  while(!worker.state.lastPoll)await new Promise(r=>setTimeout(r,5));
  const before=claims;worker.notifyCommitted();
  const until=Date.now()+300;while(claims===before&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
  assert.ok(claims>before,'signal must wake before the1second polling timer');
  assert.equal(worker.state.committedSignals,1);assert.ok(worker.state.lastInboundAt);
  assert.equal(worker.state.lastResult,null);
 }finally{await worker?.stop();await rm(dir,{recursive:true,force:true});}
});

test('answer review rejection holds the request before any provider send',async()=>{
 let sends=0;const result=await processRequest({query:async()=>({rows:[]})},async()=>{sends++;return {sent:true};},job,async()=>({reply:'Incorrect fixture answer',status:'review',verification:'fixture'}),{reviewGenerate:async()=>({reply:'{"accepted":false,"issues":["incorrect"]}'})});
 assert.equal(result.failureCode,'AGENT_ANSWER_REVIEW_FAILED');assert.equal(result.failureStage,'verification');assert.equal(result.generationFailed,false);assert.equal(sends,0);
});
test('approved answer still uses one existing CAS delivery',async()=>{
 let sends=0,checks=0;const result=await processRequest({query:async()=>({rows:[]})},async(route)=>{if(route==='/operator/result')sends++;return {sent:true};},job,async()=>({reply:'12',status:'completed',verification:'fixture'}),{reviewGenerate:async(input,options)=>{checks++;assert.equal(options.reviewOnly,true);assert.equal(options.env.CLOUD_EXECUTOR_ENABLED,'false');return {reply:'{"accepted":true,"issues":[]}'};}});
 assert.equal(result.sent,true);assert.equal(checks,1);assert.equal(sends,1);
});
test('reviewer outage cannot send unchecked text or stop unrelated generation',async()=>{
 let sends=0;const result=await processRequest({query:async()=>({rows:[]})},async()=>{sends++;},job,async()=>({reply:'fixture',status:'completed'}),{reviewGenerate:async()=>{throw Error('fixture reviewer outage');}});
 assert.equal(result.review,true);assert.equal(result.failureStage,'verification');assert.equal(result.generationFailed,false);assert.equal(sends,0);
});
