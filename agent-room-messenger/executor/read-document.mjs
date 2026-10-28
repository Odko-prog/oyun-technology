import {createRequire} from 'node:module';
import {crc32} from 'node:zlib';
const require=createRequire(import.meta.url);
const yauzl=require('yauzl');
const {SaxesParser}=require('saxes');
const word=new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main']);
const drawing=new Set(['http://schemas.openxmlformats.org/drawingml/2006/main','http://purl.oclc.org/ooxml/drawingml/main']);

export function documentXmlText(bytes){
 const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 // No DTD, external entities, includes, relationship traversal or macro execution.
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('Document DTD not supported');
 const parser=new SaxesParser({xmlns:true});let depth=0,textDepth=0,deletedDepth=0,result='';
 const add=s=>{result+=s;if(result.length>2_000_000)throw Error('Document text limit');};
 parser.on('doctype',()=>{throw Error('Document DTD not supported');});
 parser.on('error',error=>{throw error;});
 parser.on('opentag',tag=>{
  if(++depth>128)throw Error('XML nesting limit');
  if(word.has(tag.uri)&&tag.local==='del')deletedDepth++;
  if(!deletedDepth&&(word.has(tag.uri)||drawing.has(tag.uri))){
   if(tag.local==='t')textDepth++;
   if(['tab'].includes(tag.local))add('\t');
   if(['br','cr'].includes(tag.local))add('\n');
  }
 });
 parser.on('text',text=>{if(textDepth&&!deletedDepth)add(text);});
 parser.on('cdata',text=>{if(textDepth&&!deletedDepth)add(text);});
 parser.on('closetag',tag=>{
  if(!deletedDepth&&(word.has(tag.uri)||drawing.has(tag.uri))){
   if(tag.local==='t')textDepth--;
   if(tag.local==='p')add('\n');
   if(tag.local==='tc')add('\t');
  }
  if(word.has(tag.uri)&&tag.local==='del')deletedDepth--;
  depth--;
 });
 parser.write(xml).close();return result.trim();
}

export async function readDocument(bytes,name){
 if(!Buffer.isBuffer(bytes)||bytes.length>5_000_000)throw Error('Input size limit');
 const ext=name.toLowerCase().split('.').pop();
 if(!['docx','pptx'].includes(ext)){
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw Error('Unsupported binary input');
  return {format:'utf8',text,coverage:'Decoded text only; no visual rendering.'};
 }
 const select=ext==='docx'?/^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/:/^ppt\/slides\/slide\d+\.xml$/;
 const zip=await new Promise((ok,no)=>yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(e,z)=>e?no(e):ok(z)));
 if(zip.entryCount>2048){zip.close();throw Error('ZIP entry count limit');}
 const seen=new Set(),parts=[];let declared=0,read=0,media=0;
 await new Promise((ok,no)=>{
  let ended=false;
  const fail=e=>{if(ended)return;ended=true;zip.close();no(e);};
  zip.on('error',fail);zip.on('end',()=>{if(!ended){ended=true;ok();}});
  zip.on('entry',async entry=>{
   try{
    if(seen.has(entry.fileName))throw Error('Duplicate ZIP entry');seen.add(entry.fileName);
    if(entry.generalPurposeBitFlag&1)throw Error('Encrypted document unsupported');
    declared+=entry.uncompressedSize;if(declared>64_000_000)throw Error('ZIP size limit');
    if(/\/(media|embeddings)\//.test(entry.fileName))media++;
    if(select.test(entry.fileName)){
     if(parts.length>=256||entry.uncompressedSize>2_000_000||entry.uncompressedSize>Math.max(1,entry.compressedSize)*200)throw Error('Document part limit');
     const stream=await new Promise((resolve,reject)=>zip.openReadStream(entry,(e,s)=>e?reject(e):resolve(s)));
     const chunks=[];let size=0;
     for await(const chunk of stream){size+=chunk.length;read+=chunk.length;if(size>2_000_000||read>8_000_000){stream.destroy();throw Error('Document expansion limit');}chunks.push(chunk);}
     const data=Buffer.concat(chunks);if(data.length!==entry.uncompressedSize||crc32(data)!==entry.crc32)throw Error('Document CRC mismatch');
     parts.push({name:entry.fileName,text:documentXmlText(data)});
    }
    if(!ended)zip.readEntry();
   }catch(e){fail(e);}
  });zip.readEntry();
 });
 if(ext==='docx'&&!parts.some(p=>p.name==='word/document.xml'))throw Error('Word main text missing');
 if(!parts.length)throw Error('Document text parts missing');
 parts.sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));
 return {format:ext,text:parts.map(p=>`[Package part: ${p.name}]\n${p.text}`).join('\n\n'),parts:parts.map(p=>p.name),unreadMediaParts:media,coverage:'Extracted text parts only. Images, charts, equations, embedded objects and visual layout were not interpreted. Package part names are labels, not verified presentation order.'};
}
