'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {main:packageStage}=require('./package-global-recovery-stage');

const root=path.resolve(__dirname,'..');
const validation=JSON.parse(fs.readFileSync(path.join(root,'data','generated','global-runtime-validation.json'),'utf8'));
const unitTests=fs.readdirSync(path.join(root,'tests')).filter((name)=>name.endsWith('.test.js')).sort().map((name)=>`tests/${name}`);

function main(){
  return packageStage({
    stageId:'browser-acceptance-stage',artifactPrefix:'artifacts/browser-acceptance-stage/',generationHead:validation.generated_from_head,
    coldCommands:[
      {label:'node scripts/import-content.js',args:['scripts/import-content.js']},
      {label:'node scripts/build-browser-acceptance-matrix.js',args:['scripts/build-browser-acceptance-matrix.js']},
      {label:'node scripts/build-global-runtime-content.js',args:['scripts/build-global-runtime-content.js']},
      {label:'node scripts/export-task1-content.js',args:['scripts/export-task1-content.js']},
      {label:'node scripts/validate-global-runtime-representatives.js',args:['scripts/validate-global-runtime-representatives.js']},
      {label:'node scripts/build-browser.js',args:['scripts/build-browser.js']},
      {label:'node --test tests/*.test.js',args:['--test',...unitTests]},
    ],
  });
}
if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
