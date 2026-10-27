import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {executeCode} from './execute.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const outputDir=process.env.AGENT_JOB_OUTPUT_DIR;
if(!outputDir||!resolve(outputDir).includes('agent-room-'))throw Error('Missing trusted job output directory');
await mkdir(outputDir,{recursive:true,mode:0o700});
let calls=0,busy=false;
const server=new Server({name:'agent-room-executor',version:'0.1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{
 name:'execute_code',description:'Execute general JavaScript in an isolated WASI virtual filesystem. Use for computation, data transformation and generating real files, not a task-specific workflow. No network, host files, Node.js, process or customer account access. QuickJS ES modules: import * as std from "std"; std.open(path,"w"), puts(), close(); /output exists. Read supplied input files under /input; write finished files under /output with safe flat names. Files are collected and verified as actual bytes. Research uses the separate live web tool. Each call starts fresh. Return exported filenames in the final response; do not invent files.',
 inputSchema:{type:'object',properties:{code:{type:'string',maxLength:200000},files:{type:'object',description:'Optional /input/name to base64 encoded input bytes',additionalProperties:{type:'string'}},timeout:{type:'number',minimum:1,maximum:20}},required:['code'],additionalProperties:false}
}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
 if(request.params.name!=='execute_code')throw Error('Unknown tool');
 if(busy||++calls>12)return {isError:true,content:[{type:'text',text:'Execution budget reached; retain partial work for review.'}]};
 busy=true;
 try{
  const a=request.params.arguments||{};
  if(typeof a.code!=='string')throw Error('Code required');
  const r=await executeCode({runtime:'quickjs',code:a.code,files:a.files||{},timeout:a.timeout||10});
  const outputs=[];
  if(r.type==='complete'&&r.exitCode===0)for(const f of r.artifacts){
   const bytes=Buffer.from(f.base64,'base64');
   const sha256=createHash('sha256').update(bytes).digest('hex');
   const stored=`${calls}-${sha256}`;
   await writeFile(join(outputDir,stored),bytes,{mode:0o600,flag:'wx'});
   outputs.push({name:f.name,stored,bytes:bytes.length,sha256});
  }
  await writeFile(join(outputDir,`receipt-${calls}.json`),JSON.stringify(outputs),{mode:0o600,flag:'wx'});
  return {isError:r.type!=='complete'||r.exitCode!==0,content:[{type:'text',text:JSON.stringify({type:r.type,exitCode:r.exitCode,stdout:r.stdout,stderr:r.stderr,outputs:outputs.map(({stored,...f})=>f)})}]};
 }catch{return {isError:true,content:[{type:'text',text:'Execution failed; no deliverable was verified.'}]};}
 finally{busy=false;}
});
await server.connect(new StdioServerTransport());
