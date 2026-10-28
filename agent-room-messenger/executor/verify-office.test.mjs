import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32} from 'node:zlib';
import {verifyOfficeOutput} from './verify-office.mjs';
import {collectOutputs} from './collect.mjs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
function zip(entries){
 const chunks=[],central=[];let offset=0;
 for(const [name,value] of entries){const n=Buffer.from(name),b=Buffer.from(value),crc=crc32(b),l=Buffer.alloc(30),d=Buffer.alloc(46);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(b.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt32LE(crc,16);d.writeUInt32LE(b.length,20);d.writeUInt32LE(b.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(offset,42);chunks.push(l,n,b);central.push(d,n);offset+=l.length+n.length+b.length;}
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,cd,end]);
}
const rns='http://schemas.openxmlformats.org/package/2006/relationships';
const rel=(target,extra='')=>`<Relationships xmlns="${rns}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/>${extra}</Relationships>`;
const fixture=()=>[
 ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
 ['_rels/.rels',rel('word/document.xml')],
 ['word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Сайн байна</w:t></w:r></w:p></w:body></w:document>']
];
test('Office structural QA verifies real package bytes and explicitly excludes rendering',async()=>{
 const value=await verifyOfficeOutput(zip(fixture()),'answer.docx');
 assert.equal(value.structuralValidation,'passed');assert.equal(value.visualValidation,'not_performed');assert.equal(value.entries,3);
 assert.equal(await verifyOfficeOutput(Buffer.from('x'),'result.csv'),null);
});
test('PPTX main package and exact namespace are validated without claiming slide layout',async()=>{
 const entries=[['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'],['_rels/.rels',rel('ppt/presentation.xml')],['ppt/presentation.xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>']];
 assert.equal((await verifyOfficeOutput(zip(entries),'answer.pptx')).format,'pptx');
 entries[2][1]='<p:presentation xmlns:p="https://fake.invalid/presentationml"/>';
 await assert.rejects(verifyOfficeOutput(zip(entries),'bad.pptx'),/root/);
});
test('Office missing parts, wrong type, malformed XML, DTD and active content fail closed',async()=>{
 const missing=fixture().slice(0,2),wrong=fixture();wrong[0][1]=wrong[0][1].replace('document.main+xml','template.main+xml');
 const malformed=fixture();malformed[2][1]='<broken>';
 const dtd=fixture();dtd[2][1]='<!DOCTYPE x>'+dtd[2][1];
 for(const entries of [missing,wrong,malformed,dtd,[...fixture(),['word/vbaProject.bin','active']], [...fixture(),['word/document.xml','<x/>']]])await assert.rejects(verifyOfficeOutput(zip(entries),'bad.docx'));
 await assert.rejects(verifyOfficeOutput(Buffer.from('not a Word file'),'bad.docx'));
});
test('Internal relationships resolve package-relative targets; external hyperlinks are counted without fetching',async()=>{
 const good=fixture();good.push(['word/_rels/document.xml.rels',`<Relationships xmlns="${rns}"><Relationship Id="rId2" Type="image" Target="media/a.png"/><Relationship Id="rId3" Type="hyperlink" Target="https://never-fetch.invalid/" TargetMode="External"/></Relationships>`],['word/media/a.png','image bytes']);
 assert.equal((await verifyOfficeOutput(zip(good),'good.docx')).externalRelationships,1);
 for(const target of ['media/missing.png','../../outside.xml','https://never-fetch.invalid/','%2e%2e/%2e%2e/outside.xml']){
  const bad=fixture();bad.push(['word/_rels/document.xml.rels',`<Relationships xmlns="${rns}"><Relationship Id="rId2" Type="image" Target="${target}"/></Relationships>`]);await assert.rejects(verifyOfficeOutput(zip(bad),'bad.docx'));
 }
});
test('CRC damage is rejected even in non-XML package media',async()=>{
 const bytes=zip([...fixture(),['word/media/a.png','abc']]);const media=bytes.indexOf(Buffer.from('abc'));bytes[media]=100;
 await assert.rejects(verifyOfficeOutput(bytes,'bad.docx'),/CRC/);
});
test('export collector rejects hash-correct fake Office bytes and preserves honest structural receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agent-room-office-output-'));
 try{
  const save=async bytes=>{const sha256=createHash('sha256').update(bytes).digest('hex'),stored='1-'+sha256;await writeFile(join(dir,stored),bytes);await writeFile(join(dir,'receipt-1.json'),JSON.stringify([{name:'answer.docx',stored,bytes:bytes.length,sha256}]));};
  await save(Buffer.from('fake Word document'));await assert.rejects(collectOutputs(dir,['answer.docx']));
  await save(zip(fixture()));const [out]=await collectOutputs(dir,['answer.docx']);
  assert.equal(out.officeValidation.structuralValidation,'passed');assert.equal(out.officeValidation.visualValidation,'not_performed');
 }finally{await rm(dir,{recursive:true,force:true});}
});

