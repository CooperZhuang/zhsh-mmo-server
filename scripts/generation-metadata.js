'use strict';

const childProcess=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const referenceRoot=path.resolve(root,'..','zhsh-references');
const stageStartHead='2cbae183aa369fe0ac60176f3a1396914d786440';
const reproducibleGeneratedAt='2026-07-18T00:00:00.000Z';
const repositories={
  zhsh:path.join(referenceRoot,'zhsh'),
  astrbot:path.join(referenceRoot,'zhsh-game_astrbot'),
  dpcq:path.join(referenceRoot,'dpcq'),
  zonghengsihai:path.join(referenceRoot,'zonghengsihai'),
};

function git(args,cwd=root){
  const safeArgs=['-c',`safe.directory=${path.resolve(cwd).replaceAll('\\','/')}`,...args];
  const result=childProcess.spawnSync('git',safeArgs,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});
  if(result.status!==0)throw new Error(`git ${args.join(' ')} failed: ${result.error?.message??result.stderr}`);
  return result.stdout.trim();
}

function generatedFromHead(){return process.env.ZHSH_GENERATED_FROM_HEAD??git(['rev-parse','HEAD']);}

function referenceCommits(){
  if(Object.values(repositories).every((directory)=>fs.existsSync(directory)))
    return Object.fromEntries(Object.entries(repositories).map(([id,directory])=>[id,git(['rev-parse','HEAD'],directory)]));
  const snapshotPath=path.join(root,'data','generated','reference-repository-readonly-state.json');
  const snapshot=JSON.parse(fs.readFileSync(snapshotPath,'utf8')),commits=snapshot.reference_commits??{};
  if(snapshot.verification_result!=='passed'||snapshot.reference_repositories_modified!==false)throw new Error('Cold reference snapshot is not an accepted read-only verification');
  for(const id of Object.keys(repositories))if(!/^[0-9a-f]{40}$/.test(commits[id]??''))throw new Error(`Cold reference snapshot is missing ${id}`);
  return Object.fromEntries(Object.keys(repositories).map((id)=>[id,commits[id]]));
}

function generationMetadata(generatorVersion){
  const head=generatedFromHead();
  return {stage_start_head:stageStartHead,source_head:head,generated_from_head:head,reference_commits:referenceCommits(),
    generator_version:generatorVersion,generated_at:reproducibleGeneratedAt};
}

function repositorySnapshot(id,directory){
  return {repository:id,head:git(['rev-parse','HEAD'],directory),branch:git(['branch','--show-current'],directory),
    tree:git(['rev-parse','HEAD^{tree}'],directory),status_porcelain:git(['status','--porcelain','--untracked-files=all'],directory)};
}

function allReferenceSnapshots(){return Object.entries(repositories).map(([id,directory])=>repositorySnapshot(id,directory));}

module.exports={allReferenceSnapshots,generationMetadata,git,referenceCommits,repositories,reproducibleGeneratedAt,root,stageStartHead};
