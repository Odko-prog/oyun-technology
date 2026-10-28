// A request can continue only an older request belonging to the same customer.
// Model-selected references are untrusted until the database proves ownership.
export async function goalSchema(pool){await pool.query(`ALTER TABLE messenger_requests ADD COLUMN IF NOT EXISTS goal_id UUID REFERENCES messenger_requests(id); CREATE INDEX IF NOT EXISTS messenger_requests_goal ON messenger_requests(sender_id,goal_id,created_at); CREATE TABLE IF NOT EXISTS messenger_goal_steps(request_id UUID PRIMARY KEY REFERENCES messenger_requests(id),goal_id UUID NOT NULL REFERENCES messenger_requests(id),sender_id TEXT NOT NULL,state TEXT NOT NULL,verification TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);}
export async function recordGoalStep(pool,job,draft){
 const prior=draft.continues_request_id??null;
 if(prior!==null&&(typeof prior!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior)))throw Error('Invalid continuation reference');
 if(!['completed','review','awaiting_customer'].includes(draft.status))throw Error('Invalid goal state');
 const verification=typeof draft.verification==='string'?draft.verification.slice(0,4000):'';
 // The CTE scopes BOTH the parent and the leased current request; no caller can
 // attach a guessed customer ID or an expired worker to another goal.
 const result=await pool.query(`WITH parent AS (SELECT COALESCE(goal_id,id) AS id FROM messenger_requests WHERE id=$4 AND sender_id=$2 AND created_at<$5), linked AS (UPDATE messenger_requests SET goal_id=CASE WHEN $4::UUID IS NULL THEN id ELSE (SELECT id FROM parent) END WHERE id=$1 AND sender_id=$2 AND lease=$3 AND status='processing' AND lease_until>NOW() AND (goal_id IS NULL OR goal_id=CASE WHEN $4::UUID IS NULL THEN id ELSE (SELECT id FROM parent) END) AND ($4::UUID IS NULL OR EXISTS(SELECT 1 FROM parent)) RETURNING id,goal_id,sender_id) INSERT INTO messenger_goal_steps(request_id,goal_id,sender_id,state,verification) SELECT id,goal_id,sender_id,'prepared',$6 FROM linked ON CONFLICT(request_id) DO UPDATE SET verification=EXCLUDED.verification,updated_at=NOW() WHERE messenger_goal_steps.goal_id=EXCLUDED.goal_id AND messenger_goal_steps.sender_id=EXCLUDED.sender_id RETURNING goal_id`,[job.id,job.sender_id,job.lease,prior,job.created_at,verification]);
 if(result.rows.length!==1)throw Error('Continuation ownership or lease conflict');
 return result.rows[0].goal_id;
}
export async function recordGoalDelivery(pool,job,result,status){
 // Only the existing provider receipt can establish delivered completion.
 // An uncertain attempt is recorded for review and never causes a resend.
 await pool.query(`UPDATE messenger_goal_steps s SET state=CASE WHEN r.provider_id IS NOT NULL AND r.status=$4 THEN $4 ELSE 'review' END,updated_at=NOW() FROM messenger_requests r WHERE s.request_id=r.id AND r.id=$1 AND r.sender_id=$2 AND r.lease=$3 AND s.sender_id=$2`,[job.id,job.sender_id,job.lease,result.sent?status:'review']);
}
