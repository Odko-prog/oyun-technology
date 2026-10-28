import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {openLocalConnection} from './connection.mjs';
import {prepareWorkspace,runAttendedTask,verifyChatGPTLogin} from './runner.mjs';
import {collectLocalResult} from './collect-result.mjs';
const yes=s=>s.trim().toLowerCase()==='yes';
export async function runLocalAgent({workspace,ask,write,signal,connect=openLocalConnection,run=runAttendedTask,collect=collectLocalResult,authenticate=verifyChatGPTLogin,pause=ms=>sleep(ms,undefined,{signal})}){
 const root=await prepareWorkspace(workspace);
 write('Агентуудын өрөө — эзний оролцоотой холболт. Энд баталсан ажлыг сонгосон хавтсанд ажиллуулна. Ctrl+C-ээр хаана. Автоматаар асах үйлчилгээ суулгахгүй.');
 if(!yes(await ask('Энэ хавтсыг өөрийн Page яриатай холбох уу? Батлах бол yes: ')))return {state:'declined'};
 await authenticate();let connection;
 try{
  connection=await connect({label:'Owner local agent'});
  write('Өөрийн Messenger-ээс Агентуудын өрөө Page рүү дараах холбох мессежийг илгээнэ: https://www.facebook.com/profile.php?id=61595841421312');write(connection.pairingMessage);
  let status=await connection.status();
  while(status.state==='pending_page'){await pause(2000);status=await connection.status();}
  if(status.state!=='pending_owner')throw Error('Unexpected pairing state');
  write('Page ярианы холбоос батлагдлаа. Ажил эхлээгүй. Энэ цонхыг өөрийн хяналтад байлгана.');
  if(!yes(await ask('Та энэ компьютерийн эзэн бөгөөд холбох мессежийг өөрөө илгээсэн бол yes: ')))return {state:'declined'};
  await connection.activate({workspaceLabel:'Selected workspace',confirmed:true});
  while(!signal?.aborted){
   if((await connection.status()).state!=='active')throw Error('Device session no longer active');
   const tasks=await connection.tasks();if(!tasks.length){await pause(5000);continue;}
   for(const task of tasks){
    let grant;
    const result=await run({task,workspace:root,signal,authenticate,
     askOwner:async details=>{write('\nREQUEST '+details.requestId+'\n'+details.goal);return yes(await ask('Дээрх ажлыг энэ компьютерт ажиллуулах уу? Батлах бол yes: '))?{approvedGoalHash:details.goalHash}:null;},
     acceptTask:async args=>{grant=await connection.acceptTask(args);return grant;},
     isSessionActive:async()=>{if((await connection.status()).state!=='active')return false;if(!grant)return true;return (await connection.taskStatus(task.id)).state==='running';}
    });
    if(result.state==='declined'){await connection.declineTask(task.id);continue;}
    if(result.state==='stopped')return {state:'stopped'};
    if(result.exitCode!==0){await connection.cancelTask(task.id,result.lease);write('Codex алдаатай дууслаа. Үр дүн илгээгээгүй.');continue;}
    write('Хийсэн ажил, outputs дахь файлуудыг шалгана. Программ хаагдсанаар ажил дууссан гэж үзэхгүй.');
    const summary=await ask('Бэлэн үр дүнгийн товч утга (нууц үг, түлхүүр оруулахгүй): '),verification=await ask('Юуг бодитоор шалгасан бэ? ');
    const names=(await ask('Илгээх файлын нэрийг outputs хавтсаас таслалаар ялгаж бичнэ; зөвхөн текст бол хоосон: ')).split(',').map(s=>s.trim()).filter(Boolean);
    const payload=await collect(root,{summary,verification,names});
    write('Сонгосон файлууд: '+payload.files.map(f=>f.name).join(', '));
    if(!yes(await ask('Шалгасан энэ үр дүнг тухайн Page хэрэглэгчид илгээх үү? Батлах бол yes: '))){await connection.cancelTask(task.id,result.lease);continue;}
    await connection.submitResult(task.id,{lease:result.lease,...payload});
    write('Сервер үр дүнг хүлээж авлаа. Messenger хүргэлт хараахан батлагдаагүй; энэ цонхыг нээлттэй байлгана.');
    for(;;){const delivery=await connection.taskStatus(task.id);if(delivery.delivered){write('Messenger үр дүнг хүлээн авсан нь батлагдлаа.');break;}if(['review','cancelled'].includes(delivery.deliveryState)||delivery.state==='cancelled')throw Error('Delivery requires review; do not resend');await pause(2000);}
   }
  }
  return {state:'stopped'};
 }finally{
  if(connection){try{await connection.revoke();write('Төхөөрөмжийн холболт цуцлагдлаа.');}catch{write('Локал холболт хаагдлаа. Сервер дээрх цуцлалт батлагдаагүй тул алсын ажлыг үргэлжлүүлэхгүй.');}}
 }
}
async function main(){
 if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js22 or newer required');
 if(process.platform!=='win32')throw Error('This attended launcher currently targets Windows');
 const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
 const ask=async text=>{const rl=createInterface({input:stdin,output:stdout});try{return await rl.question(text,{signal:controller.signal});}finally{rl.close();}};
 await runLocalAgent({workspace:resolve(process.argv[2]||'workspace'),ask,write:text=>stdout.write(text+'\n'),signal:controller.signal});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Ажил бүрэн дуусаагүй. Энэ цонх болон ажиллаж буй программуудыг шалгана. Амжилт, хүргэлт батлагдсан гэж үзээгүй.');process.exitCode=1;});
