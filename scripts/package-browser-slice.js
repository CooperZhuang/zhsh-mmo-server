'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname,'..');
const artifactDirectory = path.join(root,'artifacts');
const outputPath = path.join(artifactDirectory,'zhsh-browser-first-playable-slice.zip');
const include = [
  'package.json',
  'web',
  'src/task-runtime',
  'scripts/build-browser.js',
  'scripts/dev-server.js',
  'scripts/export-task1-content.js',
  'scripts/package-browser-slice.js',
  'tests/browser-playable.test.js',
  'tests/task-runtime.test.js',
  'docs/development/browser-playable-slice.md',
  'docs/development/browser-playable-review-summary.md',
  'docs/development/browser-playable-validation.json',
  'docs/development/browser-playable-evidence',
];

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(),'zhsh-browser-slice-'));
const packageRoot = path.join(temporaryRoot,'zhsh-browser-first-playable-slice');
try {
  for (const relative of include) {
    const source = path.join(root,relative);
    const destination = path.join(packageRoot,relative);
    fs.mkdirSync(path.dirname(destination),{ recursive:true });
    fs.cpSync(source,destination,{ recursive:true,force:true });
  }
  fs.mkdirSync(artifactDirectory,{ recursive:true });
  const escapePowerShell = (value) => value.replaceAll("'","''");
  const command = `Compress-Archive -LiteralPath '${escapePowerShell(packageRoot)}' -DestinationPath '${escapePowerShell(outputPath)}' -Force`;
  const result = childProcess.spawnSync('powershell.exe',['-NoProfile','-Command',command],{ encoding:'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Compress-Archive failed with status ${result.status}`);
  console.log(outputPath);
} finally {
  fs.rmSync(temporaryRoot,{ recursive:true,force:true });
}
