'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {allReferenceSnapshots,generationMetadata,root}=require('./generation-metadata');

const startPath=path.join(root,'data','runtime','reference-repository-stage-start.json');
const outputPath=path.join(root,'data','generated','reference-repository-readonly-state.json');

function main(){
  const current=allReferenceSnapshots();
  if(process.argv.includes('--start')){
    if(fs.existsSync(startPath))throw new Error('Reference stage-start evidence already exists; refusing to overwrite it');
    const record={schema_version:1,record_kind:'reference-repository-stage-start',...generationMetadata('reference-state-capture/1.0.0'),repositories:current};
    fs.mkdirSync(path.dirname(startPath),{recursive:true});fs.writeFileSync(startPath,`${JSON.stringify(record,null,2)}\n`,'utf8');
    process.stdout.write(`${JSON.stringify({output:path.relative(root,startPath),repositories:current.length},null,2)}\n`);return record;
  }
  if(!fs.existsSync(startPath))throw new Error('Run with --start before formal repository work');
  const start=JSON.parse(fs.readFileSync(startPath,'utf8'));const before=new Map(start.repositories.map((entry)=>[entry.repository,entry]));
  const comparisons=current.map((after)=>{const prior=before.get(after.repository);return {repository:after.repository,before:prior,after,
    unchanged:Boolean(prior)&&prior.head===after.head&&prior.tree===after.tree&&prior.branch===after.branch&&prior.status_porcelain===after.status_porcelain,
    clean_before:prior?.status_porcelain==='',clean_after:after.status_porcelain===''};});
  const verified=comparisons.every((entry)=>entry.unchanged&&entry.clean_before&&entry.clean_after);
  if(!verified)throw new Error(`Reference repository state changed: ${JSON.stringify(comparisons.filter((entry)=>!entry.unchanged||!entry.clean_after))}`);
  const record={schema_version:1,record_kind:'reference-repository-readonly-verification',...generationMetadata('reference-state-capture/1.0.0'),
    verification_result:'passed',reference_repositories_modified:false,comparisons};
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,`${JSON.stringify(record,null,2)}\n`,'utf8');
  process.stdout.write(`${JSON.stringify({output:path.relative(root,outputPath),verification_result:record.verification_result},null,2)}\n`);return record;
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
