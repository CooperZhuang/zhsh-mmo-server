'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT_ROOT } = require('../src/data/database');
const { validateDatabase } = require('../src/data/validator');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

try {
  const args = process.argv.slice(2);
  const databasePath = path.resolve(valueAfter(args, '--database') ?? path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite'));
  const outputPath = valueAfter(args, '--output');
  if (!fs.existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}. Run the importer first.`);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let report;
  try {
    report = validateDatabase(db, { baselinePath: valueAfter(args, '--baseline'), overlayPath: valueAfter(args, '--overlay') });
  } finally {
    db.close();
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json, 'utf8');
  }
  process.stdout.write(json);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
