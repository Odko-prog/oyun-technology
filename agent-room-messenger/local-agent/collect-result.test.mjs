import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collectLocalResult} from './collect-result.mjs';
test('only explicit selected output bytes are collected; credentials, traversal and hard links rejected',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agent-room-collect-'));await mkdir(join(root,'outputs'));
 try{
  await writeFile(join(root,'outputs','result.csv'),'x,y\n1,2');await writeFile(join(root,'outputs','not-selected.txt'),'not selected');await writeFile(join(root,'outputs','auth.json'),'private');
  const result=await collectLocalResult(root,{summary:'Done',verification:'Owner checked content',names:['result.csv']});assert.equal(result.files.length,1);assert.equal(Buffer.from(result.files[0].base64,'base64').toString(),'x,y\n1,2');assert.ok(!JSON.stringify(result).includes('not selected'));
  for(const names of [['auth.json'],['../private'],['result.csv','result.csv']])await assert.rejects(collectLocalResult(root,{summary:'Done',verification:'Checked',names}));
  await link(join(root,'outputs','result.csv'),join(root,'outputs','linked.csv'));await assert.rejects(collectLocalResult(root,{summary:'Done',verification:'Checked',names:['linked.csv']}));
 }finally{await rm(root,{recursive:true,force:true});}
});
