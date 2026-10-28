import test from 'node:test';
import assert from 'node:assert/strict';
import {readPdf} from './read-pdf.mjs';
import {readDocument} from './read-document.mjs';
function pdf(text='warehouse-X9 total 1765',pages=1){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const kids=[];
 for(let n=0;n<pages;n++){const page=objects.length+1,content=page+1;kids.push(`${page} 0 R`);objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);const data=text?`BT /F1 12 Tf 50 700 Td (${text}) Tj ET`:'';objects.push(`<< /Length ${Buffer.byteLength(data)} >>\nstream\n${data}\nendstream`);}
 objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
 let out='%PDF-1.7\n';const offsets=[0];for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const xref=Buffer.byteLength(out);out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(out);
}
test('readDocument PDF uses isolated actual text extraction and explicit visual limitations',async()=>{
 const r=await readDocument(pdf(),'fixture.pdf');assert.equal(r.pages,1);assert.equal(r.emptyPages,0);assert.match(r.text,/warehouse-X9 total 1765/);assert.match(r.coverage,/visual layout were not interpreted/);assert.ok(r.peakRssKiB<192*1024);
});
test('empty PDF text layer is reported without inventing OCR or image contents',async()=>{
 const r=await readPdf(pdf(''));assert.equal(r.emptyPages,1);assert.match(r.coverage,/may need OCR/);assert.equal(r.text,'[PDF page 1]\n');
});
test('page cap, malformed PDF, size limit and aborted parser fail closed',async()=>{
 await assert.rejects(readPdf(pdf('x',101)),/unavailable/);await assert.rejects(readPdf(Buffer.from('%PDF-1.7 malformed')),/unavailable/);await assert.rejects(readPdf(Buffer.alloc(5_000_001)),/size limit/);
 const c=new AbortController();c.abort();await assert.rejects(readPdf(pdf(),{signal:c.signal}),/process unavailable/);
});

