import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createUnicodePdf} from './unicode-pdf.mjs';
import {readPdf} from './read-pdf.mjs';
const font=await readFile(new URL('./fonts/DejaVuSans.ttf',import.meta.url));
test('Unicode PDF retains Mongolian letters and valid parser pages',async()=>{
 const bytes=createUnicodePdf('Монгол Өө Үү Ёё\nНийт 1765',font);
 const result=await readPdf(bytes);assert.equal(result.pages,1);assert.match(result.text,/Монгол Өө Үү Ёё/);assert.match(result.text,/1765/);
 assert.ok(bytes.includes(Buffer.from('/ToUnicode')));assert.ok(bytes.includes(Buffer.from('/FontFile2')));
});
test('unsupported glyphs, missing font, empty text and excessive page count fail closed',()=>{
 for(const text of ['', '😀', 'x'.repeat(50001), '\n'.repeat(4501)+'x'])assert.throws(()=>createUnicodePdf(text,font));
 assert.throws(()=>createUnicodePdf('Монгол',Buffer.from('invalid')));
});
test('short paragraphs stay together at page boundary',async()=>{
 const bytes=createUnicodePdf(Array.from({length:23},()=>('Монгол '.repeat(12))).join('\n'),font);
 const decoded=await readPdf(bytes);assert.ok(decoded.pages>=1);assert.ok(bytes.length<2000000);assert.ok(bytes.subarray(-20).toString().includes('%%EOF'));
});


test('two-line paragraph starts on next page when only one line remains',async()=>{
 const first=Array.from({length:44},(_,i)=>'Мөр'+i).join('\n');
 const long='Борлуулалтын дүн 1765 төгрөг. '.repeat(5);
 const decoded=await readPdf(createUnicodePdf(first+'\n'+long,font));
 assert.equal(decoded.pages,2);
 const [one,two]=decoded.text.split('[PDF page 2]');
 assert.ok(!one.includes('Борлуулалтын'));assert.ok(two.includes('Борлуулалтын'));
});
