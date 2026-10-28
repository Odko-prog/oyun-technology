// Bounded reader for the bundled, immutable TrueType font; not arbitrary uploads.
export function trueTypeMetrics(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<100||bytes.length>2_000_000||bytes.readUInt32BE(0)!==0x10000)throw Error('Invalid TrueType');
 const count=bytes.readUInt16BE(4),tables=new Map();
 if(count>100||12+16*count>bytes.length)throw Error('Invalid TrueType tables');
 for(let i=0;i<count;i++){const p=12+16*i,tag=bytes.toString('ascii',p,p+4),start=bytes.readUInt32BE(p+8),length=bytes.readUInt32BE(p+12);if(start+length>bytes.length||tables.has(tag))throw Error('Invalid TrueType table');tables.set(tag,bytes.subarray(start,start+length));}
 const get=(name,min)=>{const t=tables.get(name);if(!t||t.length<min)throw Error('Missing TrueType table');return t;};
 const head=get('head',54),hhea=get('hhea',36),maxp=get('maxp',6),hmtx=get('hmtx',4),cmap=get('cmap',4);
 const units=head.readUInt16BE(18),metrics=hhea.readUInt16BE(34),glyphs=maxp.readUInt16BE(4);
 if(!units||!metrics||metrics>glyphs||hmtx.length<metrics*4)throw Error('Invalid TrueType metrics');
 let sub;
 const maps=cmap.readUInt16BE(2);if(maps>100||4+maps*8>cmap.length)throw Error('Invalid cmap');
 for(let i=0;i<maps;i++){const p=4+i*8,offset=cmap.readUInt32BE(p+4);if(offset+4>cmap.length)throw Error('Invalid cmap offset');if(cmap.readUInt16BE(offset)===4&&cmap.readUInt16BE(p)===3){const length=cmap.readUInt16BE(offset+2);if(offset+length>cmap.length)throw Error('Invalid cmap length');sub=cmap.subarray(offset,offset+length);break;}}
 if(!sub||sub.length<16)throw Error('BMP cmap unavailable');
 const segments=sub.readUInt16BE(6)/2,end=14,start=end+segments*2+2,delta=start+segments*2,range=delta+segments*2;
 if(!Number.isInteger(segments)||segments>8192||range+segments*2>sub.length)throw Error('Invalid cmap segments');
 function glyph(code){
  if(!Number.isInteger(code)||code<0||code>0xffff||code>=0xd800&&code<=0xdfff)throw Error('Unsupported Unicode character');
  for(let i=0;i<segments;i++){if(code>sub.readUInt16BE(end+i*2))continue;if(code<sub.readUInt16BE(start+i*2))return 0;const d=sub.readInt16BE(delta+i*2),r=sub.readUInt16BE(range+i*2);let g;if(!r)g=(code+d)&65535;else{const p=range+i*2+r+2*(code-sub.readUInt16BE(start+i*2));if(p+2>sub.length)throw Error('Invalid glyph offset');g=sub.readUInt16BE(p);if(g)g=(g+d)&65535;}if(g>=glyphs)throw Error('Invalid glyph index');return g;}return 0;
 }
 return {unitsPerEm:units,glyph,advance:code=>{const g=glyph(code);if(!g)throw Error('Missing font glyph');return hmtx.readUInt16BE(Math.min(g,metrics-1)*4)*1000/units;}};
}
