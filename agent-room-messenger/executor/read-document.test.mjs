import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync,crc32} from 'node:zlib';
import {readDocument,documentXmlText} from './read-document.mjs';
function zip(entries){
 const locals=[],central=[];let offset=0;
 for(const [name,value] of entries){const n=Buffer.from(name),b=Buffer.from(value),c=deflateRawSync(b),crc=crc32(b);const l=Buffer.alloc(30);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(8,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(c.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);const d=Buffer.alloc(46);d.writeUInt32LE(0x02014b50);d.writeUInt16LE(20,4);d.writeUInt16LE(20,6);d.writeUInt16LE(8,10);d.writeUInt32LE(crc,16);d.writeUInt32LE(c.length,20);d.writeUInt32LE(b.length,24);d.writeUInt16LE(n.length,28);d.writeUInt32LE(offset,42);locals.push(l,n,c);central.push(d,n);offset+=l.length+n.length+c.length;}
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,cd,end]);
}
const xml=text=>`<x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body><x:p><x:r><x:t>${text}</x:t></x:r></x:p></x:body></x:document>`;
test('DOCX namespace-aware actual text and entities are decoded without following URLs',async()=>{
 const r=await readDocument(zip([['word/document.xml',xml('Сайн &amp; үнэн &#49;')],['word/_rels/document.xml.rels','https://private.invalid/'],['word/media/image1.png','not decoded']]),'file.docx');
 assert.match(r.text,/Сайн & үнэн 1/);assert.equal(r.unreadMediaParts,1);assert.doesNotMatch(r.text,/private.invalid/);assert.match(r.coverage,/not interpreted/);
});
test('PPTX text parts are labelled without claiming presentation ordering or visual QA',async()=>{
 const r=await readDocument(zip([['ppt/slides/slide2.xml','<p:sld xmlns:p="urn:p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Second part</a:t></a:r></a:p></p:sld>']]),'slides.pptx');
 assert.deepEqual(r.parts,['ppt/slides/slide2.xml']);assert.match(r.text,/Second part/);assert.match(r.coverage,/not verified presentation order/);
});
test('malformed, DTD, unsafe, duplicate and oversized packages fail closed',async()=>{
 for(const data of [zip([['../word/document.xml',xml('x')]]),zip([['word/document.xml',xml('a')],['word/document.xml',xml('b')]]),zip([['word/document.xml','<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>'+xml('&e;')]]),zip([['word/document.xml',xml('A'.repeat(2_000_001))]]),zip([['word/document.xml','<broken>']])])await assert.rejects(readDocument(data,'bad.docx'));
 assert.throws(()=>documentXmlText(Buffer.from('<r>'.repeat(130)+'</r>'.repeat(130))),/nesting/);
});
test('wrong-format and corrupted CRC are rejected, normal text still reads',async()=>{
 assert.equal((await readDocument(Buffer.from('a,b\n1,2'),'data.csv')).text,'a,b\n1,2');
 await assert.rejects(readDocument(Buffer.from('%PDF\0binary'),'file.pdf'));
 const bad=zip([['word/document.xml',xml('text')]]);const cd=bad.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bad.writeUInt32LE(1,cd+16);await assert.rejects(readDocument(bad,'bad.docx'),/CRC/);
});
test('bounded XLSX ZIP adapter resolves shared cell values and keeps cached formula provenance',async()=>{
 const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 const r=await readDocument(zip([['xl/sharedStrings.xml',`<sst xmlns="${ns}"><si><t>warehouse-X9</t></si></sst>`],['xl/worksheets/sheet1.xml',`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>35</v></c><c r="C1"><v>47</v></c><c r="D1"><f>B1*C1</f><v>1645</v></c></row></sheetData></worksheet>`]]),'fixture.xlsx');
 assert.equal(r.format,'xlsx');assert.equal(r.cellCount,4);assert.match(r.text,/warehouse-X9/);assert.match(r.text,/1645/);assert.match(r.text,/B1\*C1/);assert.match(r.coverage,/NOT executed or recalculated/);
});
test('generic binary Office inputs infer one bounded package type and reject ambiguous containers',async()=>{
 const word=zip([['word/document.xml',xml('actual generic binary Word text')]]);assert.equal((await readDocument(word,'attachment.bin')).format,'docx');
 const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';const sheet=`<worksheet xmlns="${ns}"><c r="A1"><v>1765</v></c></worksheet>`;
 const xlsx=zip([['xl/workbook.xml',`<workbook xmlns="${ns}"/>`],['xl/worksheets/sheet1.xml',sheet]]);const r=await readDocument(xlsx,'attachment.bin');assert.equal(r.format,'xlsx');assert.match(r.text,/1765/);
 await assert.rejects(readDocument(zip([['word/document.xml',xml('x')],['xl/workbook.xml','<workbook/>']]),'attachment.bin'),/ambiguous/);
 await assert.rejects(readDocument(zip([['unrelated.txt','x']]),'attachment.bin'),/Unknown/);
});

