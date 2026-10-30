import test from 'node:test';import assert from 'node:assert/strict';
import {parseAnswerReview,answerReviewInput,reviewTextAnswer,canReviewAnswer} from './answer-review.mjs';
test('answer review fails closed for malformed, contradictory or unknown verdicts',()=>{
 for(const t of ['bad','{}','{"accepted":true,"issues":["incorrect"]}','{"accepted":false,"issues":[]}','{"accepted":false,"issues":["private text"]}'])assert.throws(()=>parseAnswerReview(t));
 assert.deepEqual(parseAnswerReview('{"accepted":false,"issues":["incorrect"]}'),{accepted:false,issues:['incorrect']});
});
test('native image review retains only same-job image bytes outside prompt JSON',async()=>{
 const input={text:'fixture',attachment_types:['image'],input_files:[{name:'a.png',mime:'image/png',bytes:3,sha256:'a'.repeat(64),url:'SECRET'},{name:'private.txt',mime:'text/plain'}],input_file_bytes:{'/input/a.png':'AQID','/input/private.txt':'PRIVATE'}};
 assert.equal(canReviewAnswer(input,{reply:'16'}),true);
 const review=answerReviewInput(input,{reply:'16'});
 assert.deepEqual(review.input_file_bytes,{'/input/a.png':'AQID'});
 assert.equal(review.input_files.length,1);assert.equal(review.input_files[0].url,undefined);
 assert.ok(!review.text.includes('AQID'));assert.ok(!review.text.includes('PRIVATE'));assert.ok(!review.text.includes('SECRET'));
 let calls=0;await reviewTextAnswer(input,{reply:'16'},async(r,o)=>{calls++;assert.equal(r.input_file_bytes['/input/a.png'],'AQID');assert.equal(o.reviewOnly,true);return {reply:'{"accepted":true,"issues":[]}'};});assert.equal(calls,1);
});
test('review routing excludes unsupported attachments and device/artifact workflows',()=>{
 assert.equal(canReviewAnswer({attachment_types:['file'],input_files:[{name:'a.pdf'}]},{}),false);
 assert.equal(canReviewAnswer({attachment_types:['image'],input_files:[]},{}),false);
 assert.equal(canReviewAnswer({device_pairing:{matched:true}},{}),false);
 assert.equal(canReviewAnswer({}, {device_task:{}}),false);
 assert.equal(canReviewAnswer({}, {artifacts:[{}]}),false);
});
test('review boundary includes goal and draft but no file bytes, signed links or operational credentials',()=>{
 const r=answerReviewInput({text:'fixture',input_file_bytes:{'/input/a':'PRIVATE'},history:[]},{reply:'draft',artifacts:[{name:'a.txt',bytes:Buffer.from('hidden'),sha256:'a'.repeat(64),url:'SECRET'}]});
 assert.ok(!r.text.includes('PRIVATE'));assert.ok(!r.text.includes('SECRET'));assert.deepEqual(r.input_file_bytes,{});
});
test('text answer review uses a separate text-only generation call and never sends',async()=>{
 let calls=0;const r=await reviewTextAnswer({text:'7+5?'},{reply:'13'},async(input,options)=>{calls++;assert.equal(options.env.CLOUD_EXECUTOR_ENABLED,'false');return {reply:'{"accepted":false,"issues":["incorrect"]}'};},{env:{CLOUD_EXECUTOR_ENABLED:'true'}});
 assert.equal(calls,1);assert.equal(r.accepted,false);
});
test('independent current-source review enables live research while retaining executor isolation',async()=>{
 await reviewTextAnswer({text:'Current price?'},{reply:'Fixture price',status:'completed'},async(input,options)=>{
  assert.equal(options.reviewOnly,true);assert.equal(options.reviewWeb,true);assert.equal(options.env.CLOUD_EXECUTOR_ENABLED,'false');
  assert.match(input.text,/independently open the cited primary sources/);assert.match(input.text,/exact product variants/);
  return {reply:'{"accepted":false,"issues":["unsupported_claim"]}'};
 },{env:{CLOUD_EXECUTOR_ENABLED:'true'}});
});
test('cited answer cannot pass on model claims without observed independent web evidence',async()=>{
 const draft={reply:'Current price: 100. Source https://example.com/product',status:'completed'};
 for(const evidence of [undefined,{webSearchCompleted:0}]){
  const v=await reviewTextAnswer({},draft,async()=>({reply:'{"accepted":true,"issues":[]}',reviewEvidence:evidence}));
  assert.deepEqual(v,{accepted:false,issues:['unsupported_claim']});
 }
 const v=await reviewTextAnswer({},draft,async()=>({reply:'{"accepted":true,"issues":[]}',reviewEvidence:{webSearchCompleted:1}}));assert.equal(v.accepted,true);
});
