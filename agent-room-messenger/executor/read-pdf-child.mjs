// Trusted parser child. Only stdin bytes and this parser's installed module tree are readable.
console.log=console.warn=console.info=()=>{};
globalThis.fetch=async()=>{throw Error('External PDF resources disabled');};
let raw='';
try{
 for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>6_700_000)throw Error('PDF transport limit');}
 const bytes=Buffer.from(raw,'base64');if(!bytes.length||bytes.length>5_000_000||!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw Error('Invalid PDF input');
 const {getDocument}=await import(process.argv[2]);
 class NoExternalData {async fetch(){throw Error('External PDF resources disabled');}}
 const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,useWasm:false,stopAtErrors:true,verbosity:0,BinaryDataFactory:NoExternalData});
 try{
  const doc=await task.promise;if(doc.numPages>100)throw Error('PDF page limit');
  const parts=[];let characters=0,items=0,emptyPages=0;
  for(let n=1;n<=doc.numPages;n++){
   const page=await doc.getPage(n),stream=page.streamTextContent(),reader=stream.getReader();let text='';
   try{while(true){const chunk=await reader.read();if(chunk.done)break;
    for(const item of chunk.value.items){if(++items>100000)throw Error('PDF item limit');if(typeof item.str!=='string')continue;const value=item.str+(item.hasEOL?'\n':' ');characters+=value.length;if(characters>500000)throw Error('PDF text limit');text+=value;}
   }}finally{await reader.cancel().catch(()=>{});page.cleanup();}
   if(!text.trim())emptyPages++;parts.push({page:n,text:text.trim()});
  }
  process.stdout.write(JSON.stringify({ok:true,format:'pdf',pages:doc.numPages,emptyPages,text:parts.map(p=>`[PDF page ${p.page}]\n${p.text}`).join('\n\n'),parts:parts.map(p=>`page ${p.page}`),coverage:'Extracted PDF text layer only. Images, scanned text, charts, equations and visual layout were not interpreted; empty pages may need OCR.',peakRssKiB:process.resourceUsage().maxRSS}));
 }finally{await task.destroy();}
}catch{process.stdout.write(JSON.stringify({ok:false,error:'PDF text unavailable or parser limit reached; password-protected, malformed or scanned content may require another tool.'}));process.exitCode=1;}

