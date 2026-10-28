import {createUnicodePdf} from './unicode-pdf.mjs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {executeCode} from './execute.mjs';
import {readDocument} from './read-document.mjs';
import {verifyOfficeOutput} from './verify-office.mjs';
import {verifyPdfOutput} from './verify-pdf.mjs';
import {writeFile,mkdir,readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

const outputDir=process.env.AGENT_JOB_OUTPUT_DIR;
if(!outputDir||!resolve(outputDir).includes('agent-room-'))throw Error('Missing trusted job output directory');
await mkdir(outputDir,{recursive:true,mode:0o700});
const inputPath=process.env.AGENT_JOB_INPUT_FILE;
let trustedFiles={};
if(inputPath){
 if(resolve(inputPath)!==resolve(outputDir,'../inputs.json'))throw Error('Invalid trusted input location');
 const stat=await lstat(inputPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>14_000_000)throw Error('Invalid trusted inputs');
 trustedFiles=JSON.parse(await readFile(inputPath,'utf8'));
 if(Object.keys(trustedFiles).length>8)throw Error('Input file count limit');
 for(const [name,data] of Object.entries(trustedFiles))if(!/^\/input\/[\p{L}\p{N} _().-]{1,120}$/u.test(name)||name.includes('..')||typeof data!=='string')throw Error('Invalid trusted input');
}
let calls=0,busy=false;
const server=new Server({name:'agent-room-executor',version:'0.1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{
 name:'execute_code',description:'Execute general JavaScript in an isolated WASI virtual filesystem. Use for computation, data transformation and generating real files, not a task-specific workflow. No network, host files, Node.js, process or customer account access. QuickJS ES modules: import * as std from "std"; std.open(path,"w"), puts(), close(); /output exists. For binary output use a Uint8Array and std.open(path,"wb"), then file.write(data.buffer,data.byteOffset,data.byteLength) and file.close(); check the write count. Generate the real file format bytes, never rename plain text to a binary format. For Mongolian or other non-Latin PDF text, raw UTF-8 in a standard Helvetica/Type1 text string is insufficient: use a genuinely available font with the required glyphs, embed its permitted font program and provide correct character encoding and ToUnicode mapping. Never invent a font file or claim embedding/render verification from parser success. If those bytes or a supported renderer are unavailable, preserve the original Unicode in a supported editable document or text deliverable, clearly explain the PDF limitation, and do not transliterate or replace requested letters silently. Read supplied input files under /input; write finished files under /output with safe flat names. Files are collected and verified as actual bytes. Research uses the separate live web tool. Each call starts fresh. Return exported filenames in the final response; do not invent files.',
 inputSchema:{type:'object',properties:{code:{type:'string',maxLength:200000},files:{type:'object',description:'Optional /input/name to base64 encoded input bytes',additionalProperties:{type:'string'}},timeout:{type:'number',minimum:1,maximum:20}},required:['code'],additionalProperties:false}
},{name:'create_text_pdf',description:'Create a real plain text PDF with bundled embedded DejaVu font and Unicode mapping. Mongolian Cyrillic and supported BMP glyphs only; missing glyphs fail. Word wrapping and short-paragraph pagination, no tables, images, shaping or equation layout. Supply final text, maximum50000characters; output is structurally validated, not visually rendered.',inputSchema:{type:'object',properties:{name:{type:'string'},text:{type:'string',maxLength:50000}},required:['name','text'],additionalProperties:false}},{name:'read_input',description:'Read actual supplied UTF-8 text, bounded DOCX/PPTX text parts, XLSX cell values and stored formula/cache text, or a PDF text layer using an isolated bounded parser. Only this job files can be read. Returns actual text, coverage and nextOffset. Continue paging when needed; returned text is not visual rendering. Spreadsheet formulas are never executed or recalculated; dates and formatting are not interpreted. PDF pages with empty text may require OCR; scanned text, images, embedded objects, equations and layout are not interpreted. Filenames alone do not prove contents.',annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},inputSchema:{type:'object',properties:{name:{type:'string'},offset:{type:'integer',minimum:0}},required:['name'],additionalProperties:false}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
 if(!['execute_code','read_input','create_text_pdf'].includes(request.params.name))throw Error('Unknown tool');
 if(busy||++calls>12)return {isError:true,content:[{type:'text',text:'Execution budget reached; retain partial work for review.'}]};
 busy=true;
 try{
  const a=request.params.arguments||{};
  if(request.params.name==='read_input'){
   const name='/input/'+a.name;if(!Object.hasOwn(trustedFiles,name))throw Error('Input not supplied');
   const bytes=Buffer.from(trustedFiles[name],'base64');
   const document=await readDocument(bytes,a.name);
   const text=document.text;
   const offset=Number.isInteger(a.offset)&&a.offset>=0?a.offset:0;
   return {content:[{type:'text',text:JSON.stringify({name:a.name,format:document.format,coverage:document.coverage,parts:document.parts,pages:document.pages,emptyPages:document.emptyPages,unreadMediaParts:document.unreadMediaParts,text:text.slice(offset,offset+24000),nextOffset:offset+24000<text.length?offset+24000:null,totalCharacters:text.length})}]};
  }
  let r;
  if(request.params.name==='create_text_pdf'){
   if(typeof a.name!=='string'||! /^[\p{L}\p{N} _().-]{1,120}\.pdf$/u.test(a.name)||a.name.includes('..')||a.name.startsWith('.'))throw Error('Invalid PDF name');
   const font=await readFile(new URL('./fonts/DejaVuSans.ttf',import.meta.url));
   if(createHash('sha256').update(font).digest('hex')!=='7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954')throw Error('Font integrity failed');
   const bytes=createUnicodePdf(a.text,font);
   r={type:'complete',exitCode:0,stdout:'',stderr:'',artifacts:[{name:a.name,base64:bytes.toString('base64')}]};
  }else{
  if(typeof a.code!=='string')throw Error('Code required');
  if(Object.keys(a.files||{}).some(name=>Object.hasOwn(trustedFiles,name)))throw Error('Cannot overwrite supplied input');
  r=await executeCode({runtime:'quickjs',code:a.code,files:{...(a.files||{}),...trustedFiles},timeout:a.timeout||10});
  }
  const outputs=[],prepared=[];
  if(r.type==='complete'&&r.exitCode===0)for(const f of r.artifacts){
   const bytes=Buffer.from(f.base64,'base64');
   let officeValidation;
   try{officeValidation=await verifyOfficeOutput(bytes,f.name);}catch{const error=Error('Office output structure invalid');error.code='OFFICE_STRUCTURE_INVALID';throw error;}
   let pdfValidation;
   try{pdfValidation=await verifyPdfOutput(bytes,f.name);}catch{const error=Error('PDF output structure invalid');error.code='PDF_STRUCTURE_INVALID';throw error;}
   const sha256=createHash('sha256').update(bytes).digest('hex');
   const stored=`${calls}-${sha256}`;
   prepared.push({name:f.name,stored,data:bytes,bytes:bytes.length,sha256,...(officeValidation?{officeValidation}:{}),...(pdfValidation?{pdfValidation}:{})});
  }
  // Verify the complete output set before persisting any receipt or exported bytes.
  for(const {data:bytes,...f} of prepared){
   const {stored}=f;
   if(!outputs.some(f=>f.stored===stored))await writeFile(join(outputDir,stored),bytes,{mode:0o600,flag:'wx'});
   outputs.push(f);
  }
  await writeFile(join(outputDir,`receipt-${calls}.json`),JSON.stringify(outputs),{mode:0o600,flag:'wx'});
  return {isError:r.type!=='complete'||r.exitCode!==0,content:[{type:'text',text:JSON.stringify({type:r.type,exitCode:r.exitCode,stdout:r.stdout,stderr:r.stderr,outputs:outputs.map(({stored,...f})=>f)})}]};
 }catch(error){return {isError:true,content:[{type:'text',text:error?.code==='OFFICE_STRUCTURE_INVALID'?'Office output structural validation failed. Repair the actual ZIP CRC, XML, main content type and relationship targets, then export again. No files from this call were accepted; visual rendering was not performed.':error?.code==='PDF_STRUCTURE_INVALID'?'PDF output structural validation failed. Export a complete unencrypted PDF with valid pages and text streams, header and EOF marker, within 5 MB and 100 pages. No files from this call were accepted; visual rendering was not performed.':'Execution failed; no deliverable was verified.'}]};}
 finally{busy=false;}
});
await server.connect(new StdioServerTransport());


