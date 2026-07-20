'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT_ROOT } = require('../src/data/database');
const queries = require('../src/data/queries');

const commands = {
  cities: { argument: false, run: queries.allCities },
  'city-locations': { argument: true, run: queries.cityLocations },
  neighbors: { argument: true, run: queries.adjacentLocations },
  'location-npcs': { argument: true, run: queries.locationNpcs },
  'task-series': { argument: false, run: queries.taskSeries },
  task: { argument: true, run: queries.taskDetails },
  provenance: { argument: true, run: queries.provenance },
  'static-counts': { argument: false, run: queries.staticCounts },
  dependencies: { argument: false, run: queries.dependencySummary },
  trial: { argument: true, run: queries.trialDetails },
};

function usage() {
  return 'Usage: node scripts/query-content.js [--database path] <cities|city-locations|neighbors|location-npcs|task-series|task|trial|provenance|static-counts|dependencies> [canonical_id or name]';
}

try {
  const args = process.argv.slice(2);
  const databaseFlag = args.indexOf('--database');
  let databasePath = path.join(PROJECT_ROOT, 'data', 'zhsh-content.sqlite');
  if (databaseFlag >= 0) {
    databasePath = path.resolve(args[databaseFlag + 1]);
    args.splice(databaseFlag, 2);
  }
  const [commandName, argument] = args;
  const command = commands[commandName];
  if (!command || (command.argument && !argument)) throw new Error(usage());
  if (!fs.existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}. Run the importer first.`);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA foreign_keys = ON');
  try {
    process.stdout.write(`${JSON.stringify(command.argument ? command.run(db, argument) : command.run(db), null, 2)}\n`);
  } finally {
    db.close();
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
