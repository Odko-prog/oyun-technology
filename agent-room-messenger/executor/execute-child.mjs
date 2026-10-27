// Trusted host adapter. Customer code receives only a WASI virtual filesystem.
import {runFS} from '@runno/sandbox';
let raw='';
for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>2_000_000)process.exit(2);}
try {
 const {runtime,code,files,timeout}=JSON.parse(raw);
 if(!['python','quickjs'].includes(runtime)||typeof code!=='string'||code.length>200000)throw Error('Invalid program');
 const stamps={access:new Date(),modification:new Date(),change:new Date()};
 const fs={'/program':{path:'/program',mode:'string',content:code,timestamps:stamps},'/output/.runno':{path:'/output/.runno',mode:'string',content:'',timestamps:stamps}};
 for(const [name,base64] of Object.entries(files||{})){
  if(!/^\/input\/[\p{L}\p{N} _().-]{1,120}$/u.test(name)||name.includes('..'))throw Error('Invalid input name');
  fs[name]={path:name,mode:'binary',content:new Uint8Array(Buffer.from(base64,'base64')),timestamps:stamps};
 }
 const r=await runFS(runtime,'/program',fs,{timeout:Math.min(20,Math.max(1,timeout||10))});
 const artifacts=[];let total=0;
 if(r.resultType==='complete')for(const [path,f] of Object.entries(r.fs)){
  if(!path.startsWith('/output/'))continue;
  const name=path.slice(8);
  if(name==='.runno')continue; // WASI virtual directory marker, not a deliverable.
  if(!/^[\p{L}\p{N} _().-]{1,120}$/u.test(name)||name.includes('..'))throw Error('Invalid output name');
  const b=Buffer.from(f.content);total+=b.length;
  if(b.length>5_000_000||total>10_000_000||artifacts.length>=8)throw Error('Output transport limit');
  artifacts.push({name,base64:b.toString('base64')});
 }
 console.log(JSON.stringify({type:r.resultType,exitCode:r.exitCode??null,stdout:(r.stdout||'').slice(0,16000),stderr:(r.stderr||'').slice(0,4000),artifacts,peakRssKiB:process.resourceUsage().maxRSS}));
 process.exit(0);
} catch {console.log(JSON.stringify({type:'adapter_error',artifacts:[]}));process.exit(0);}
