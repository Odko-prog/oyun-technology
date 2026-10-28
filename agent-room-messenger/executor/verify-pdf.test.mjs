import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyPdfOutput} from './verify-pdf.mjs';
import {collectOutputs} from './collect.mjs';

function fixture(){
 const stream='BT /F1 12 Tf 50 700 Td (PDF output QA 1765) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let out='%PDF-1.7\n';const offsets=[];
 objects.forEach((obj,i)=>{offsets.push(out.length);out+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
 const xref=out.length;out+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(out);
}
test('PDF output parser evidence excludes extracted private text and visual claims',async()=>{
 const value=await verifyPdfOutput(fixture(),'result.PDF');assert.equal(value.pages,1);assert.equal(value.structuralValidation,'passed');assert.equal(value.visualValidation,'not_performed');assert.equal(value.emptyTextPages,0);assert.ok(!JSON.stringify(value).includes('1765'));assert.equal(await verifyPdfOutput(Buffer.from('x'),'result.csv'),null);
});
test('renamed text, truncated and header/EOF-only fake PDFs fail closed',async()=>{
 for(const bytes of [Buffer.from('fake PDF'),fixture().subarray(0,-10),Buffer.from('%PDF-1.7\n%%EOF')])await assert.rejects(verifyPdfOutput(bytes,'bad.pdf'));
});
test('receipt and hash cannot make a malformed PDF deliverable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agent-room-pdf-output-'));
 try{for(const bytes of [Buffer.from('%PDF-1.7\n%%EOF'),fixture()]){
  const sha256=createHash('sha256').update(bytes).digest('hex'),stored=`1-${sha256}`;await writeFile(join(dir,stored),bytes);await writeFile(join(dir,'receipt-1.json'),JSON.stringify([{name:'result.pdf',stored,bytes:bytes.length,sha256}]));
  if(bytes.length<30)await assert.rejects(collectOutputs(dir,['result.pdf']));else{const result=await collectOutputs(dir,['result.pdf']);assert.deepEqual(result[0].bytes,bytes);assert.equal(result[0].pdfValidation.pages,1);}
 }}finally{await rm(dir,{recursive:true,force:true});}
});
