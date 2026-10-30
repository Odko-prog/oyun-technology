// Retain tool counters only. Never persist event text, queries, URLs or model output.
export function reviewTrace(){
 let pending='',discard=false,webSearchCompleted=0;
 return {
  consume(chunk){
   for(const part of String(chunk).split(/(?<=\n)/)){
    if(!discard)pending+=part;
    if(pending.length>500000){pending='';discard=true;}
    if(!part.endsWith('\n'))continue;
    if(!discard){try{const event=JSON.parse(pending);if(event.type==='item.completed'&&event.item?.type==='web_search')webSearchCompleted++;}catch{}}
    pending='';discard=false;
   }
  },
  evidence(){return {webSearchCompleted};}
 };
}
