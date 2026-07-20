'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {stableJson}=require('./build-progression-source-fixture');

const root=path.resolve(__dirname,'..');
const defaultFixturePath=path.join(root,'tests','fixtures','progression-source-evidence.json');

function verifyColdFixture(fixturePath=defaultFixturePath){
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  const results=[];
  for(const record of fixture.records){
    if(!Array.isArray(record.random_rules))throw new Error(`${record.canonical_id}: random_rules must be explicit`);
    if(record.evidence_kind==='line_range'){
      if(sha256(record.snippet)!==record.snippet_sha256)throw new Error(`${record.canonical_id}: snippet hash mismatch`);
      if(record.snippet.split('\n').length!==record.line_end-record.line_start+1)throw new Error(`${record.canonical_id}: line span mismatch`);
    }else if(record.evidence_kind==='json_pointer'){
      if(record.json_pointer!=='/')throw new Error(`${record.canonical_id}: unsupported JSON pointer`);
      if(sha256(stableJson(record.value))!==record.value_sha256)throw new Error(`${record.canonical_id}: JSON value hash mismatch`);
    }else throw new Error(`${record.canonical_id}: unsupported evidence kind`);
    results.push({canonical_id:record.canonical_id,status:'PASS'});
  }
  return {mode:'cold-fixture',fixture_path:path.relative(root,fixturePath).replaceAll('\\','/'),record_count:results.length,results};
}

function verifyAgainstReferences(referenceRoot,fixturePath=defaultFixturePath){
  const fixture=JSON.parse(fs.readFileSync(fixturePath,'utf8'));
  verifyColdFixture(fixturePath);
  const results=[];
  for(const record of fixture.records){
    const repositoryDirectory=record.repository==='astrbot'?'zhsh-game_astrbot':record.repository;
    const sourcePath=path.join(referenceRoot,repositoryDirectory,...record.relative_path.split('/'));
    const bytes=fs.readFileSync(sourcePath);
    if(sha256(bytes)!==record.file_sha256)throw new Error(`${record.canonical_id}: source file hash mismatch`);
    if(record.evidence_kind==='line_range'){
      const lines=bytes.toString('utf8').replaceAll('\r\n','\n').split('\n');
      const snippet=lines.slice(record.line_start-1,record.line_end).join('\n');
      if(snippet!==record.snippet)throw new Error(`${record.canonical_id}: source snippet mismatch`);
    }else{
      const value=JSON.parse(bytes.toString('utf8'));
      if(stableJson(value)!==stableJson(record.value))throw new Error(`${record.canonical_id}: source JSON value mismatch`);
    }
    results.push({canonical_id:record.canonical_id,status:'PASS'});
  }
  return {mode:'reference-repository',reference_root:path.resolve(referenceRoot),record_count:results.length,results};
}

function sha256(value){return crypto.createHash('sha256').update(value).digest('hex');}

if(require.main===module){
  const referenceIndex=process.argv.indexOf('--reference-root');
  const fixtureIndex=process.argv.indexOf('--fixture');
  const fixturePath=fixtureIndex>=0?path.resolve(process.argv[fixtureIndex+1]):defaultFixturePath;
  const result=referenceIndex>=0?verifyAgainstReferences(path.resolve(process.argv[referenceIndex+1]),fixturePath):verifyColdFixture(fixturePath);
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
}

module.exports={verifyAgainstReferences,verifyColdFixture};
