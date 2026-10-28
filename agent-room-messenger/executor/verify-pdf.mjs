import {readPdf} from './read-pdf.mjs';

// Parser acceptance is structural evidence only; it does not prove visual fidelity.
export async function verifyPdfOutput(bytes,name){
 if(!/\.pdf$/i.test(name))return null;
 if(!Buffer.isBuffer(bytes)||bytes.length>5_000_000||!/^%PDF-\d\.\d/.test(bytes.subarray(0,16).toString('ascii'))||!bytes.subarray(-1024).toString('latin1').trimEnd().endsWith('%%EOF'))throw Error('PDF output header or EOF invalid');
 const result=await readPdf(bytes);
 if(!Number.isInteger(result.pages)||result.pages<1)throw Error('PDF output has no pages');
 return {format:'pdf',structuralValidation:'passed',pages:result.pages,emptyTextPages:result.emptyPages,visualValidation:'not_performed',coverage:'Bounded parser accepted PDF pages and text streams. Rendering, fonts, images and visual layout were not verified.'};
}
