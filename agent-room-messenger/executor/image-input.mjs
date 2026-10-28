import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
const png=Buffer.from([137,80,78,71,13,10,26,10]);
function bounded(width,height){if(!width||!height||width>8192||height>8192||width*height>10_000_000)throw Error('Image pixel limit');}
export function imageDimensions(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length>5_000_000)throw Error('Image byte limit');
 if(bytes.subarray(0,8).equals(png)){
  let offset=8,count=0,width,height,data=false,ended=false;
  while(offset<bytes.length){
   if(++count>4096||offset+12>bytes.length)throw Error('Invalid PNG chunks');
   const n=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8),end=offset+12+n;
   if(end>bytes.length||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))throw Error('Invalid PNG CRC');
   if(count===1){if(type!=='IHDR'||n!==13)throw Error('PNG header missing');width=bytes.readUInt32BE(offset+8);height=bytes.readUInt32BE(offset+12);bounded(width,height);}
   else if(type==='IHDR')throw Error('Duplicate PNG header');
   if(type==='acTL')throw Error('Animated PNG unsupported');
   if(type==='IDAT')data=true;
   if(type==='IEND'){if(n!==0||end!==bytes.length)throw Error('Invalid PNG ending');ended=true;break;}
   offset=end;
  }
  if(!ended||!data)throw Error('Incomplete PNG');return {format:'png',width,height};
 }
 if(bytes[0]===255&&bytes[1]===216){
  if(bytes.at(-2)!==255||bytes.at(-1)!==217)throw Error('Incomplete JPEG');
  let offset=2,count=0,dimensions;
  while(offset<bytes.length-2){
   if(++count>4096||bytes[offset++]!==255)throw Error('Invalid JPEG marker');while(bytes[offset]===255)offset++;
   const marker=bytes[offset++];if(marker===0xda){if(!dimensions)throw Error('JPEG dimensions missing');return dimensions;}
   if(marker===0xd8||marker===0xd9||marker===0||offset+2>bytes.length)throw Error('Invalid JPEG segment');
   const n=bytes.readUInt16BE(offset);if(n<2||offset+n>bytes.length)throw Error('Invalid JPEG length');
   if([0xc0,0xc1,0xc2].includes(marker)){if(dimensions||n<8)throw Error('Invalid JPEG frame');const height=bytes.readUInt16BE(offset+3),width=bytes.readUInt16BE(offset+5);bounded(width,height);dimensions={format:'jpeg',width,height};}
   offset+=n;
  }
  throw Error('JPEG scan missing');
 }
 throw Error('Only PNG and JPEG image input supported');
}
export async function prepareImageInputs(input,dir){
 const prepared=[];
 for(const metadata of input.input_files||[]){
  const encoded=input.input_file_bytes?.['/input/'+metadata.name];if(typeof encoded!=='string'){if(String(metadata.mime||'').startsWith('image/')||/\.(png|jpe?g)$/i.test(metadata.name))throw Error('Image bytes missing');continue;}
  const bytes=Buffer.from(encoded,'base64');
  const isImage=String(metadata.mime||'').startsWith('image/')||/\.(png|jpe?g)$/i.test(metadata.name)||bytes.subarray(0,8).equals(png)||(bytes[0]===255&&bytes[1]===216);
  if(!isImage)continue;
  if(prepared.length>=4)throw Error('Image count limit');
  if(bytes.toString('base64')!==encoded||metadata.bytes!==bytes.length||metadata.sha256!==createHash('sha256').update(bytes).digest('hex'))throw Error('Image integrity failed');
  prepared.push({name:metadata.name,bytes,...imageDimensions(bytes)});
 }
 const imageDir=join(dir,'visual-inputs');if(prepared.length)await mkdir(imageDir,{mode:0o700});
 const args=[],images=[];
 for(const [i,image] of prepared.entries()){
  const path=join(imageDir,`${i+1}.${image.format==='jpeg'?'jpg':'png'}`);await writeFile(path,image.bytes,{mode:0o600,flag:'wx'});args.push('--image',path);images.push({name:image.name,format:image.format,width:image.width,height:image.height,attached:true});
 }
 return {args,images};
}

