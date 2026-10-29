import test from 'node:test';import assert from 'node:assert/strict';
import {parseAnswerReview,answerReviewInput,reviewTextAnswer} from './answer-review.mjs';
test('answer review fails closed for malformed, contradictory or unknown verdicts',()=>{
 for(const t of ['bad','{}','{"accepted":true,"issues":["incorrect"]}','{"accepted":false,"issues":[]}','{"accepted":false,"issues":["private text"]}'])assert.throws(()=>parseAnswerReview(t));
 assert.deepEqual(parseAnswerReview('{"accepted":false,"issues":["incorrect"]}'),{accepted:false,issues:['incorrect']});
});
test('review boundary includes goal and draft but no file bytes, signed links or operational credentials',()=>{
 const r=answerReviewInput({text:'fixture',input_file_bytes:{'/input/a':'PRIVATE'},history:[]},{reply:'draft',artifacts:[{name:'a.txt',bytes:Buffer.from('hidden'),sha256:'a'.repeat(64),url:'SECRET'}]});
 assert.ok(!r.text.includes('PRIVATE'));assert.ok(!r.text.includes('SECRET'));assert.deepEqual(r.input_file_bytes,{});
});
test('text answer review uses a separate text-only generation call and never sends',async()=>{
 let calls=0;const r=await reviewTextAnswer({text:'7+5?'},{reply:'13'},async(input,options)=>{calls++;assert.equal(options.env.CLOUD_EXECUTOR_ENABLED,'false');return {reply:'{"accepted":false,"issues":["incorrect"]}'};},{env:{CLOUD_EXECUTOR_ENABLED:'true'}});
 assert.equal(calls,1);assert.equal(r.accepted,false);
});
