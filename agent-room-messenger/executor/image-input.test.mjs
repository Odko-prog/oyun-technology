import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateSync} from 'node:zlib';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {imageDimensions,prepareImageInputs} from './image-input.mjs';
function png(width=1,height=1){const chunk=(name,data)=>{const type=Buffer.from(name),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([n,type,data,c]);};const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);}
const input=bytes=>({input_files:[{name:'customer.png',mime:'image/png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}],input_file_bytes:{'/input/customer.png':bytes.toString('base64')}});
test('PNG CRC and dimensions bound actual image transport before decoding',()=>{
 assert.deepEqual(imageDimensions(png()),{format:'png',width:1,height:1});
 for(const bytes of [png(8193,1),png(5000,5000),Buffer.from('not an image'),png().subarray(0,40)])assert.throws(()=>imageDimensions(bytes));
 const corrupt=png();corrupt[corrupt.length-1]^=1;assert.throws(()=>imageDimensions(corrupt),/CRC/);
});
test('JPEG header dimensions are bounded and incomplete frames are rejected',()=>{
 const bytes=Buffer.from('ffd8ffc0000b080002000301011100ffda0008010100003f0000ffd9','hex');assert.deepEqual(imageDimensions(bytes),{format:'jpeg',width:3,height:2});
 const large=Buffer.from(bytes);large.writeUInt16BE(9000,9);assert.throws(()=>imageDimensions(large),/pixel/);assert.throws(()=>imageDimensions(bytes.subarray(0,bytes.length-2)),/Incomplete/);
});
test('image staging uses verified same-job bytes and generated flat paths with explicit CLI flags',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agent-room-image-test-'));try{
  const bytes=png(),r=await prepareImageInputs(input(bytes),dir);assert.equal(r.args[0],'--image');assert.equal(r.args[1],join(dir,'visual-inputs','1.png'));assert.deepEqual(await readFile(r.args[1]),bytes);assert.equal(r.images[0].attached,true);assert.equal(r.images[0].name,'customer.png');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('tampered image and excessive image sets write no files',async()=>{
 for(const mode of ['hash','count']){const dir=await mkdtemp(join(tmpdir(),'agent-room-image-test-'));try{
  const data=input(png());if(mode==='hash')data.input_files[0].sha256='0'.repeat(64);else data.input_files=Array.from({length:5},()=>data.input_files[0]);
  await assert.rejects(prepareImageInputs(data,dir));assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true,force:true});}}
});
test('missing supplied image bytes fail before staging',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agent-room-image-test-'));try{const data=input(png());data.input_file_bytes={};await assert.rejects(prepareImageInputs(data,dir),/missing/);assert.deepEqual(await readdir(dir),[]);}finally{await rm(dir,{recursive:true,force:true});}
});

