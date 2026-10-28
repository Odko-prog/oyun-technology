import {trueTypeMetrics} from './truetype-metrics.mjs';
// Plain BMP text only: no shaping, equations, tables, images or layout import.
export function createUnicodePdf(text,fontBytes){
 if(typeof text!=='string'||!text.trim()||text.length>50000)throw Error('PDF text limit');
 if(/[\p{M}\p{Script=Arabic}\p{Script=Hebrew}\u202a-\u202e\u2066-\u2069]/u.test(text))throw Object.assign(Error('PDF text requires unsupported shaping or bidirectional layout'),{code:'PDF_TEXT_UNSUPPORTED'});
 text=text.replace(/\t/g,'    ');
 if(text.length>50000)throw Error('PDF text limit');
 const font=trueTypeMetrics(fontBytes),chars=[...new Set([...text].filter(c=>c!=='\n'&&c!=='\r'))];
 if(chars.length>2000)throw Error('PDF character limit');
 const ids=new Map(chars.map((c,i)=>[c,i+1])),widths=chars.map(c=>Math.round(font.advance(c.codePointAt(0))));
 const map=Buffer.alloc((chars.length+1)*2);chars.forEach((c,i)=>map.writeUInt16BE(font.glyph(c.codePointAt(0)),(i+1)*2));
 const lines=[],groups=[];for(const para of text.replace(/\r\n?/g,'\n').split('\n')){const from=lines.length;let line='',width=0;for(const token of (para.match(/\S+\s*|\s+/g)||[])){const tw=[...token].reduce((n,c)=>n+widths[ids.get(c)-1]*12/1000,0);if(line&&width+tw>499){lines.push(line.trimEnd());line='';width=0;}for(const c of token){const w=widths[ids.get(c)-1]*12/1000;if(width+w>499){lines.push(line);line='';width=0;}line+=c;width+=w;}}lines.push(line.trimEnd());groups.push(lines.slice(from));}
 if(lines.length>4500)throw Error('PDF page limit');
 const pages=[];let page=[];for(const group of groups){if(group.length<=45&&page.length+group.length>45){pages.push(page);page=[];}for(const line of group){if(page.length===45){pages.push(page);page=[];}page.push(line);}}if(page.length)pages.push(page);if(pages.length>100)throw Error('PDF page limit');
 const objects=[],add=x=>{objects.push(Buffer.isBuffer(x)?x:Buffer.from(x,'ascii'));return objects.length;};
 const stream=(bytes,extra='')=>Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${extra} >>\nstream\n`),bytes,Buffer.from('\nendstream')]);
 add('<< /Type /Catalog /Pages 2 0 R >>');add('');
 const fontFile=add(stream(fontBytes,`/Length1 ${fontBytes.length}`));
 const descriptor=add(`<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [-1100 -500 1800 1400] /ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
 const cidMap=add(stream(map));
 const cid=add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap ${cidMap} 0 R /DW 1000 /W [1 [${widths.join(' ')}]] >>`);
 const hex=n=>n.toString(16).padStart(4,'0');
 let unicode='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
 for(let i=0;i<chars.length;i+=100){const batch=chars.slice(i,i+100);unicode+=`${batch.length} beginbfchar\n`+batch.map((c,j)=>`<${hex(i+j+1)}> <${hex(c.codePointAt(0))}>`).join('\n')+'\nendbfchar\n';}
 unicode+='endcmap CMapName currentdict /CMap defineresource pop end end';
 const toUnicode=add(stream(Buffer.from(unicode,'ascii')));
 const type0=add(`<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
 const pageRefs=[];
 for(const lines of pages){const content=add(stream(Buffer.from('BT /F1 12 Tf 16 TL 48 790 Td\n'+lines.map((line,i)=>(i?'T* ':'')+'<'+[...line].map(c=>hex(ids.get(c))).join('')+'> Tj').join('\n')+'\nET','ascii')));pageRefs.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${type0} 0 R >> >> /Contents ${content} 0 R >>`));}
 objects[1]=Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${pageRefs.map(n=>`${n} 0 R`).join(' ')}] >>`);
 const chunks=[Buffer.from('%PDF-1.7\n')],offsets=[0];let offset=chunks[0].length;
 objects.forEach((obj,i)=>{offsets.push(offset);const b=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),obj,Buffer.from('\nendobj\n')]);chunks.push(b);offset+=b.length;});
 chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
 return Buffer.concat(chunks);
}
