import test from 'node:test';
import assert from 'node:assert/strict';
import {spreadsheetText} from './read-spreadsheet.mjs';
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const part=(name,xml)=>({name,bytes:Buffer.from(xml)});
test('spreadsheet shared strings, rich inline text and cached formula values retain provenance',()=>{
 const r=spreadsheetText([part('xl/sharedStrings.xml',`<sst xmlns="${ns}"><si><t>Алим</t></si></sst>`),part('xl/worksheets/sheet1.xml',`<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>35</v></c><c r="C1"><v>47</v></c><c r="D1"><f>B1*C1</f><v>1645</v></c><c r="E1" t="inlineStr"><is><r><t>part </t></r><r><t>two</t></r></is></c><c r="F1" t="b"><v>1</v></c></row></sheetData></worksheet>`)]);
 assert.match(r.text,/Алим/);assert.match(r.text,/1645/);assert.match(r.text,/B1\*C1/);assert.match(r.text,/part two/);assert.match(r.text,/"value":"true"/);assert.equal(r.cellCount,6);assert.match(r.coverage,/NOT executed or recalculated/);
});
test('spreadsheet malformed XML, DTD and invalid shared-string references fail closed',()=>{
 for(const xml of ['<broken>',`<!DOCTYPE x><worksheet xmlns="${ns}"/>`,`<worksheet xmlns="${ns}"><c r="A1" t="s"><v>999</v></c></worksheet>`])assert.throws(()=>spreadsheetText([part('xl/worksheets/sheet1.xml',xml)]));
});
test('uncached formulas are returned as text without inventing computed results',()=>{
 const r=spreadsheetText([part('xl/worksheets/sheet1.xml',`<worksheet xmlns="${ns}"><c r="A1"><f>1+1</f></c></worksheet>`)]);assert.match(r.text,/"cachedValuePresent":false/);assert.doesNotMatch(r.text,/"value":"2"/);
});
test('worksheet namespaces, cell coordinate bounds and duplicate cells are rejected',()=>{
 for(const xml of ['<worksheet xmlns="urn:wrong"/>',`<worksheet xmlns="${ns}"><c r="XFE1"><v>1</v></c></worksheet>`,`<worksheet xmlns="${ns}"><c r="A1048577"><v>1</v></c></worksheet>`,`<worksheet xmlns="${ns}"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></worksheet>`])assert.throws(()=>spreadsheetText([part('xl/worksheets/sheet1.xml',xml)]));
});

