import {createRequire} from 'node:module';
const {SaxesParser}=createRequire(import.meta.url)('saxes');
const namespaces=new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main','http://purl.oclc.org/ooxml/spreadsheetml/main']);
function parse(bytes,handlers,expectedRoot){
 const xml=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('Spreadsheet DTD rejected');
 const p=new SaxesParser({xmlns:true});let depth=0;
 p.on('error',e=>{throw e;});p.on('doctype',()=>{throw Error('Spreadsheet DTD rejected');});
 p.on('opentag',t=>{if(++depth>128)throw Error('Spreadsheet nesting limit');if(depth===1&&(t.local!==expectedRoot||!namespaces.has(t.uri)))throw Error('Spreadsheet XML root invalid');if(namespaces.has(t.uri))handlers.open?.(t);});
 p.on('text',v=>handlers.text?.(v));p.on('cdata',v=>handlers.text?.(v));
 p.on('closetag',t=>{if(namespaces.has(t.uri))handlers.close?.(t);depth--;});p.write(xml).close();
}
export function spreadsheetText(parts){
 const strings=[];let stringChars=0;
 const shared=parts.find(p=>p.name==='xl/sharedStrings.xml');
 if(shared){let value=null,inText=0;parse(shared.bytes,{open(t){if(t.local==='si'){if(strings.length>=100000)throw Error('Shared string count limit');value='';}if(t.local==='t'&&value!==null)inText++;},text(v){if(inText){stringChars+=v.length;if(stringChars>2000000)throw Error('Shared text limit');value+=v;}},close(t){if(t.local==='t'&&inText)inText--;if(t.local==='si'&&value!==null){strings.push(value);value=null;}}},'sst');}
 const sheets=parts.filter(p=>/^xl\/worksheets\/sheet\d+\.xml$/.test(p.name)).sort((a,b)=>a.name.localeCompare(b.name,'en',{numeric:true}));if(!sheets.length)throw Error('Spreadsheet worksheets missing');
 let cellCount=0,total=0;
 const result=sheets.map(part=>{
  const lines=[],seen=new Set();let cell=null,capture=null;
  parse(part.bytes,{open(t){
   if(t.local==='c'){if(cell||++cellCount>100000)throw Error('Spreadsheet cell limit');const a=t.attributes;const ref=a.r?.value,match=/^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref||'');if(!match)throw Error('Spreadsheet cell reference missing');const col=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);if(col>16384||Number(match[2])>1048576||seen.has(ref))throw Error('Spreadsheet cell reference invalid');seen.add(ref);cell={ref,type:a.t?.value||'n',value:'',formula:'',inline:'',hasValue:false};}
   if(cell&&['v','f','t'].includes(t.local)){capture=t.local;if(capture==='v')cell.hasValue=true;}
  },text(v){if(!cell||!capture)return;total+=v.length;if(total>2000000)throw Error('Spreadsheet text limit');if(capture==='v')cell.value+=v;else if(capture==='f')cell.formula+=v;else cell.inline+=v;},close(t){
   if(t.local===capture)capture=null;
   if(t.local==='c'&&cell){let value=cell.value;
    if(cell.type==='s'){if(!/^\d+$/.test(value)||Number(value)>=strings.length)throw Error('Shared string reference invalid');value=strings[Number(value)];}
    else if(cell.type==='inlineStr')value=cell.inline;
    else if(cell.type==='b'){if(!['0','1'].includes(value))throw Error('Spreadsheet boolean invalid');value=value==='1'?'true':'false';}
    const entry={cell:cell.ref,type:cell.type,value};if(cell.formula){entry.formula=cell.formula;entry.cachedValuePresent=cell.hasValue;}
    lines.push(JSON.stringify(entry));cell=null;
   }
  }},'worksheet');
  return `[Package part: ${part.name}]\n${lines.join('\n')}`;
 });
 const text=result.join('\n\n');if(text.length>2000000)throw Error('Spreadsheet output limit');
 return {format:'xlsx',text,parts:sheets.map(p=>p.name),cellCount,coverage:'Extracted worksheet cell values and stored formula text/cached results only; formulas were NOT executed or recalculated. Dates/styles/number formats, charts, images, macros and visual layout were not interpreted. Package part labels do not establish workbook sheet names or order.'};
}

