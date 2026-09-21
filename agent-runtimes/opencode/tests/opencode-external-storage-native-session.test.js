'use strict';

// Exercises the provider against a real SQLite database through the native
// db/session commands. The provider never writes rows or unlinks the database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CONFIG_ENV, SCHEMA, finalizeOwnershipMarker, handleRequest, writeOwnershipMarker } = require('../lib/opencode-external-storage-retention');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-native-retention-'));
try {
	const temp = path.join(root, 'temp');
	const data = path.join(root, 'data');
	const database = path.join(data, 'opencode.db');
	fs.mkdirSync(temp, { recursive: true });
	fs.mkdirSync(data, { recursive: true });
	const sqlite = (sql) => {
		const result = spawnSync('sqlite3', [database, sql], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
	};
	sqlite('CREATE TABLE session(id TEXT PRIMARY KEY, parent_id TEXT, time_compacting INTEGER); CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE session_input(id TEXT PRIMARY KEY, session_id TEXT, promoted_seq INTEGER);');
	sqlite("INSERT INTO session VALUES ('ses_eligible', NULL, NULL), ('ses_child', 'ses_eligible', NULL), ('ses_active', NULL, 1), ('ses_unknown', NULL, NULL), ('ses_race', NULL, NULL), ('ses_fail', NULL, NULL), ('ses_busy', NULL, NULL)");
	sqlite("INSERT INTO message VALUES ('m1', 'ses_eligible', '{\\"text\\":\\"terminal\\"}'), ('m2', 'ses_child', '{\\"text\\":\\"child\\"}'), ('m3', 'ses_active', '{\\"status\\":\\"running\\"}')");

	const command = path.join(root, 'opencode-fixture.cjs');
	fs.writeFileSync(command, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const db = ${JSON.stringify(database)};
const args = process.argv.slice(2);
const sql = args[1] || '';
const run = (query) => cp.spawnSync('sqlite3', ['-json', db, query], { encoding: 'utf8' });
if (args.join(' ') === 'debug paths') process.stdout.write('tmp  ${temp}\\ndata  ${data}\\n');
else if (args.join(' ') === 'db path') process.stdout.write(db + '\\n');
else if (args.join(' ') === 'session list --format json') process.stdout.write(JSON.stringify([
  {id:'ses_eligible', title:'terminal', updated:1, created:1, projectId:'p', directory:'${root}'},
  {id:'ses_active', title:'active', updated:1, created:1, projectId:'p', directory:'${root}'},
  {id:'ses_unknown', title:'unknown', updated:1, created:1, projectId:'p', directory:'${root}', pinned:true},
  {id:'ses_race', title:'race', updated:1, created:1, projectId:'p', directory:'${root}'},
  {id:'ses_fail', title:'fail', updated:1, created:1, projectId:'p', directory:'${root}'}, {id:'ses_busy', title:'busy', updated:1, created:1, projectId:'p', directory:'${root}'},
]));
else if (args[0] === 'db' && sql.startsWith('SELECT s.id')) {
  if (process.env.RACE_ONCE === '1' && !fs.existsSync(db + '.raced')) { fs.writeFileSync(db + '.raced', '1'); cp.spawnSync('sqlite3', [db, "UPDATE session SET time_compacting=2 WHERE id='ses_race'"]); }
  const result = run(sql); process.stdout.write(result.stdout);
}
else if (args[0] === 'session' && args[1] === 'delete') {
  if (process.env.FAIL_DELETE === '1') process.exit(1);
  const id = args[2]; const result = cp.spawnSync('sqlite3', [db, \
  \"WITH RECURSIVE kids(id) AS (SELECT id FROM session WHERE id='\" + id + \"' UNION ALL SELECT s.id FROM session s JOIN kids k ON s.parent_id=k.id) DELETE FROM session WHERE id IN (SELECT id FROM kids);\"], {encoding:'utf8'});
  process.exit(result.status || 0);
}
else if (args[0] === 'db' && args[1] === 'VACUUM') { if (process.env.FAIL_VACUUM === '1') process.exit(1); process.exit(cp.spawnSync('sqlite3', [db, 'VACUUM']).status || 0); }
`);
	fs.chmodSync(command, 0o755);
	const config = path.join(root, 'retention.json');
	fs.writeFileSync(config, JSON.stringify({ command, temp_roots: [temp], data_roots: [data] }));
	const env = { ...process.env, [CONFIG_ENV]: config, XDG_STATE_HOME: path.join(root, 'state') };
	const owned = path.join(temp, 'owned');
	fs.mkdirSync(owned);
	assert.equal(writeOwnershipMarker(owned, { task_id: 'owned', workspace: root }, env), true);
	assert.equal(finalizeOwnershipMarker(owned, 'ses_eligible', env), true);
	for (const id of ['ses_fail', 'ses_race']) {
		const markerRoot = path.join(temp, id);
		fs.mkdirSync(markerRoot);
		assert.equal(writeOwnershipMarker(markerRoot, { task_id: id, workspace: root }, env), true);
		assert.equal(finalizeOwnershipMarker(markerRoot, id, env), true);
	}
	const busyRoot = path.join(temp, 'busy');
	fs.mkdirSync(busyRoot);
	assert.equal(writeOwnershipMarker(busyRoot, { task_id: 'busy', workspace: root }, env), true);
	assert.equal(finalizeOwnershipMarker(busyRoot, 'ses_busy', env), true);

	const inventory = handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env, now: Date.now() });
	const target = (id) => { const item = inventory.items.find((entry) => entry.id === `session:${id}`); assert.ok(item, id); return { id: item.id, reclaim_token: item.reclaim_token }; };
	assert.equal(inventory.items.find((entry) => entry.id === 'session:ses_eligible').reconstructable, true);
	assert.equal(inventory.items.find((entry) => entry.id === 'session:ses_eligible').active, false);
	assert.equal(inventory.items.find((entry) => entry.id === 'session:ses_active').active, true);
	assert.equal(inventory.items.find((entry) => entry.id === 'session:ses_unknown').ownership_known, false);
	assert.equal(inventory.items.find((entry) => entry.id === 'session:ses_eligible').referenced, false, 'a terminal marker is not unfinished evidence');
	const receipt = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: inventory.generation, reclaim_targets: [target('ses_eligible'), target('ses_active'), target('ses_unknown')] }, { env, now: Date.now() });
	assert.deepEqual(receipt.reclaimed_item_ids, ['session:ses_eligible']);
	assert.equal(receipt.logical_deleted_bytes > 0, true);
	assert.equal(receipt.verified_physical_file_bytes_reclaimed >= 0, true);

	const failedInventory = handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env, now: Date.now() });
	const failed = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: failedInventory.generation, reclaim_targets: [targetFrom(failedInventory, 'ses_fail')] }, { env: { ...env, FAIL_DELETE: '1' }, now: Date.now() });
	assert.deepEqual(failed.reclaimed_item_ids, []);
	const raceInventory = handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env, now: Date.now() });
	const race = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: raceInventory.generation, reclaim_targets: [targetFrom(raceInventory, 'ses_race')] }, { env: { ...env, RACE_ONCE: '1' }, now: Date.now() });
	assert.deepEqual(race.reclaimed_item_ids, []);
	assert.ok(fs.existsSync(database));
	const busyInventory = handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env, now: Date.now() });
	const busy = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: busyInventory.generation, reclaim_targets: [targetFrom(busyInventory, 'ses_busy')] }, { env: { ...env, FAIL_VACUUM: '1' }, now: Date.now() });
	assert.deepEqual(busy.reclaimed_item_ids, ['session:ses_busy']);
	assert.equal(busy.maintenance[0].retryable, true);
	const pending = handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env, now: Date.now() }).items.find((entry) => entry.id.startsWith('compaction:'));
	assert.ok(pending, 'failed compaction remains retryable');
	const retry = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env, now: Date.now() }).generation, reclaim_targets: [{ id: pending.id, reclaim_token: pending.reclaim_token }] }, { env, now: Date.now() });
	assert.deepEqual(retry.reclaimed_item_ids, [pending.id]);
	console.log('opencode native session retention: ok');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

function targetFrom(inventory, id) {
	const item = inventory.items.find((entry) => entry.id === `session:${id}`);
	assert.ok(item, id);
	return { id: item.id, reclaim_token: item.reclaim_token };
}
