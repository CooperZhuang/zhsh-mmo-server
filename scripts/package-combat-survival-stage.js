'use strict';

const path=require('node:path');
const {main:packageStage}=require('./package-global-recovery-stage');

const root=path.resolve(__dirname,'..');
const coldCommands=[
  {label:'node scripts/import-content.js',args:['scripts/import-content.js']},
  {label:'node scripts/adjudicate-blocked-targets.js',args:['scripts/adjudicate-blocked-targets.js']},
  {label:'node scripts/import-numbers-xlsx.js',args:['scripts/import-numbers-xlsx.js']},
  {label:'node --test tests/combat-survival-source-golden.test.js',args:['--test','tests/combat-survival-source-golden.test.js']},
  {label:'node scripts/select-runnable-tasks.js',args:['scripts/select-runnable-tasks.js']},
  {label:'node --test tests/reference-golden-rules.test.js',args:['--test','tests/reference-golden-rules.test.js']},
  {label:'node --test tests/browser-playable.test.js',args:['--test','tests/browser-playable.test.js']},
  {label:'node --test tests/combat-survival.test.js tests/equipment-acquisition.test.js',args:['--test','tests/combat-survival.test.js','tests/equipment-acquisition.test.js']},
  {label:'node scripts/build-browser.js',args:['scripts/build-browser.js']},
  {label:'node scripts/build-task-playability-matrix.js',args:['scripts/build-task-playability-matrix.js']},
];

function main(){
  const outputIndex=process.argv.indexOf('--output-root');
  return packageStage({
    stageId:'combat-survival-stage',
    artifactPrefix:'artifacts/combat-survival-stage/',
    coldCommands,
    outputRoot:outputIndex>=0?path.resolve(root,process.argv[outputIndex+1]):undefined,
  });
}

if(require.main===module){try{main();}catch(error){process.stderr.write(`${error.stack??error.message}\n`);process.exitCode=1;}}
module.exports={main};
