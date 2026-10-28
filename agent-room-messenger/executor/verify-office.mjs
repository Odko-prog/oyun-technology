import {createRequire} from 'node:module';
import {crc32} from 'node:zlib';
import {posix} from 'node:path';
const require=createRequire(import.meta.url),yauzl=require('yauzl'),{SaxesParser}=require('saxes');
const relNS='http://schemas.openxmlformats.org/package/2006/relationships';
const typeNS='http://schemas.openxmlformats.org/package/2006/content-types';
const mainTypes={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'};

function xmlTags(bytes){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Office output DTD rejected');
 const parser=new SaxesParser({xmlns:true}),tags=[];let depth=0;
 parser.on('error',e=>{throw e;});parser.on('doctype',()=>{throw Error('Office output DTD rejected');});
 parser.on('opentag',tag=>{if(++depth>128||tags.length>=100000)throw Error('Office output XML limit');tags.push({name:tag.local,uri:tag.uri,attrs:Object.fromEntries(Object.values(tag.attributes).map(a=>[a.name,a.value]))});});
 parser.on('closetag',()=>depth--);parser.write(text).close();return tags;
}

// Structural package QA only. This never fetches external targets or claims rendering.
export async function verifyOfficeOutput(bytes,name){
 const ext=name.toLowerCase().split('.').pop();if(!mainTypes[ext])return null;
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>5_000_000)throw Error('Office output size limit');
 const zip=await new Promise((ok,no)=>yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(e,z)=>e?no(e):ok(z)));
 if(zip.entryCount>2048){zip.close();throw Error('Office output entry limit');}
 const entries=new Map();let total=0,xmlTotal=0;
 await new Promise((ok,no)=>{
  let ended=false;const fail=e=>{if(ended)return;ended=true;zip.close();no(e);};
  zip.on('error',fail);zip.on('end',()=>{if(!ended){ended=true;ok();}});
  zip.on('entry',async e=>{try{
   const path=e.fileName;
   if(entries.has(path)||path.includes('\\')||path.startsWith('/')||path.split('/').includes('..')||e.generalPurposeBitFlag&1)throw Error('Unsafe Office output entry');
   total+=e.uncompressedSize;if(total>32_000_000||e.uncompressedSize>8_000_000)throw Error('Office output expansion limit');
   if(/(?:vbaProject|activeX|embeddings)(?:\.|\/)/i.test(path))throw Error('Active Office output unsupported');
   const isXml=/\.(xml|rels)$/i.test(path);
   if(isXml){xmlTotal+=e.uncompressedSize;if(e.uncompressedSize>2_000_000||xmlTotal>8_000_000)throw Error('Office output XML size limit');}
   const stream=await new Promise((resolve,reject)=>zip.openReadStream(e,(err,s)=>err?reject(err):resolve(s)));
   const chunks=[];let size=0;
   for await(const c of stream){size+=c.length;if(size>e.uncompressedSize){stream.destroy();throw Error('Office output byte limit');}chunks.push(c);}
   const data=Buffer.concat(chunks);if(size!==e.uncompressedSize||crc32(data)!==e.crc32)throw Error('Office output CRC mismatch');
   entries.set(path,isXml?xmlTags(data):null);if(!ended)zip.readEntry();
  }catch(e){fail(e);}});zip.readEntry();
 });
 const types=entries.get('[Content_Types].xml'),rootRels=entries.get('_rels/.rels');
 if(types?.[0]?.name!=='Types'||types[0].uri!==typeNS||rootRels?.[0]?.name!=='Relationships'||rootRels[0].uri!==relNS)throw Error('Office output package metadata missing');
 const mains=rootRels.filter(t=>t.uri===relNS&&t.name==='Relationship'&&/\/officeDocument$/.test(t.attrs.Type||'')&&t.attrs.TargetMode!=='External');
 if(mains.length!==1)throw Error('Office output main relationship missing');
 const target=mains[0].attrs.Target?.replace(/^\//,'');
 const expected=({docx:'word/document.xml',pptx:'ppt/presentation.xml',xlsx:'xl/workbook.xml'})[ext];
 const overrides=types.filter(t=>t.uri===typeNS&&t.name==='Override'&&t.attrs.PartName==='/'+expected),defaults=types.filter(t=>t.uri===typeNS&&t.name==='Default'&&t.attrs.Extension==='xml');
 if(overrides.length>1||defaults.length>1)throw Error('Office output ambiguous main content type');
 const mainType=overrides[0]?.attrs.ContentType||defaults[0]?.attrs.ContentType;
 if(target!==expected||!entries.has(expected)||mainType!==mainTypes[ext])throw Error('Office output main part/type mismatch');
 let externalRelationships=0;
 for(const [path,tags] of entries){if(!path.endsWith('.rels'))continue;
  if(tags?.[0]?.name!=='Relationships'||tags[0].uri!==relNS)throw Error('Office output invalid relationships');
  const ids=new Set();const base=path==='_rels/.rels'?'':posix.dirname(path.replace('/_rels/','/').replace(/\.rels$/,''));
  for(const t of tags.filter(t=>t.uri===relNS&&t.name==='Relationship')){
   const a=t.attrs;if(!a.Id||ids.has(a.Id)||!a.Type||!a.Target)throw Error('Office output invalid relationship');ids.add(a.Id);
   if(a.TargetMode==='External'){externalRelationships++;continue;}
   if(a.TargetMode&&a.TargetMode!=='Internal')throw Error('Office output invalid target mode');
   let decoded;try{decoded=decodeURIComponent(a.Target.split('#')[0]);}catch{throw Error('Office output invalid target');}
   if(decoded.includes('\\')||decoded.includes('\0')||/^[a-z]+:/i.test(decoded))throw Error('Office output unsafe target');
   const resolved=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(base,decoded));
   if(resolved.startsWith('../')||!entries.has(resolved))throw Error('Office output missing relationship target');
  }
 }
 const root=entries.get(expected)[0];
 const namespace=({docx:'wordprocessingml',pptx:'presentationml',xlsx:'spreadsheetml'})[ext],rootName=({docx:'document',pptx:'presentation',xlsx:'workbook'})[ext];
 if(root.name!==rootName||![`http://schemas.openxmlformats.org/${namespace}/2006/main`,`http://purl.oclc.org/ooxml/${namespace}/main`].includes(root.uri))throw Error('Office output invalid document root');
 return {format:ext,entries:entries.size,externalRelationships,structuralValidation:'passed',visualValidation:'not_performed',coverage:'ZIP CRC, bounded XML, package main content type and internal relationship targets checked. Rendering, visual layout and factual completeness not verified.'};
}

