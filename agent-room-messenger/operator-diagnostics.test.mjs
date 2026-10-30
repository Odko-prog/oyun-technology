import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleOperator,operatorFailure} from './operator.mjs';
test('pending exposes only bounded diagnostic codes, never raw failure content',async()=>{
 const raw={failureCode:'AGENT_ANSWER_REVIEW_FAILED',reviewIssues:['incorrect','incorrect','secret raw text','needs_input'],failureStage:'verification',message:'private content',token:'secret'};
 const out=await handleOperator('/operator/pending','GET',{}, {query:async sql=>({rows:sql.startsWith('SELECT COUNT')?[{total:1}]:[{id:'fixture',execution_failure:raw}]})});
 assert.deepEqual(out.requests[0].execution_failure,{failureCode:'AGENT_ANSWER_REVIEW_FAILED',reviewIssues:['incorrect','needs_input'],failureStage:'verification'});
 assert.equal(JSON.stringify(out).includes('private content'),false);assert.equal(JSON.stringify(out).includes('secret'),false);
});
test('unknown and absent diagnostics fail closed without invented reasons',()=>{
 assert.equal(operatorFailure(null),null);assert.equal(operatorFailure('private'),null);
 assert.deepEqual(operatorFailure({failureCode:'private raw error',failureStage:'private',reviewIssues:['private']}),{failureCode:'UNCLASSIFIED'});
});
