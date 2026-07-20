'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const root = path.resolve(__dirname,'..');
const db = new DatabaseSync(path.join(root,'data','zhsh-content.sqlite'),{ readOnly:true });

try {
  const rows = db.prepare(`
    SELECT canonical_id,display_name,task_type,raw_receive_location,raw_submit_location,
      raw_target_location,description
    FROM task_definitions
    WHERE description LIKE '%钓%'
      OR description LIKE '%潜水%'
      OR description LIKE '%海底%'
      OR description LIKE '%海皇%'
      OR description LIKE '%航线%'
      OR description LIKE '%航行%'
      OR description LIKE '%出航%'
      OR raw_target_location LIKE '%浅海%'
      OR raw_target_location LIKE '%深海%'
    ORDER BY canonical_id
  `).all();
  process.stdout.write(`${JSON.stringify({ task_count:rows.length,tasks:rows },null,2)}\n`);
} finally {
  db.close();
}
