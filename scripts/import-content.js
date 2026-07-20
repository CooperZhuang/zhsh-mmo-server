'use strict';

const { runImport } = require('../src/data/importer');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

try {
  const args = process.argv.slice(2);
  const report = runImport({
    dryRun: args.includes('--dry-run'),
    baselinePath: valueAfter(args, '--baseline'),
    overlayPath: valueAfter(args, '--overlay'),
    databasePath: valueAfter(args, '--database'),
    taskSeries: valueAfter(args, '--task-series'),
    scope: valueAfter(args, '--scope'),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, operations: error.importStats ?? null }, null, 2)}\n`);
  process.exitCode = 1;
}
