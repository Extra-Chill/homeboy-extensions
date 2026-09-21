'use strict';

// Native metadata is not a session deletion authority. Event maintenance is
// delegated to the documented OpenCode commands and leaves session history.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CONFIG_ENV, SCHEMA, handleRequest } = require('../lib/opencode-external-storage-retention');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-native-retention-'));
try {
	const temp = path.join(root, 'temp');
	const data = path.join(root, 'data');
	const database = path.join(data, 'opencode.db');
	fs.mkdirSync(temp, { recursive: true });
	fs.mkdirSync(data, { recursive: true });
	const sqlite = (sql) => { const result = spawnSync('sqlite3', [database, sql], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
	sqlite("CREATE TABLE session(id TEXT PRIMARY KEY); CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT, seq INTEGER, type TEXT, data TEXT); INSERT INTO session VALUES ('ses_unknown'),('ses_pinned'),('ses_owned'); INSERT INTO event VALUES ('e1','ses_owned',1,'message.updated.1','{}'),('e2','ses_owned',2,'message.updated.1','{}');");
	const command = path.join(root, 'opencode-fixture.cjs');
	fs.writeFileSync(command, `#!/usr/bin/env node
const cp = require('node:child_process');
const args = process.argv.slice(2); const db = ${JSON.stringify(database)};
if (args.join(' ') === 'debug paths') process.stdout.write('tmp  ${temp}\\ndata  ${data}\\n');
else if (args.join(' ') === 'db path') process.stdout.write(db + '\\n');
else if (args.join(' ') === 'session list --format json') process.stdout.write(JSON.stringify([{id:'ses_unknown'},{id:'ses_pinned',owner_pid:0,pinned:true},{id:'ses_owned',owner_pid:0,pinned:false}]));
else if (args.join(' ') === 'db event-log-status') process.stdout.write(JSON.stringify({events:2,payloadBytes:200,compactableEvents:2,recommended:true}));
else if (args[0] === 'db' && args[1] === 'compact-events') {
  if (!args.includes('--apply')) process.stdout.write(JSON.stringify({dryRun:true,inspected:2,candidates:1,hasMore:true,next:{cursor:'ses_owned',afterSeq:1}}));
  else { cp.spawnSync('sqlite3', [db, "UPDATE event SET type='message.compacted.1' WHERE id='e1'"]); const backup = args[args.indexOf('--backup') + 1]; cp.spawnSync('sqlite3', [db, 'VACUUM INTO "' + backup + '"']); process.stdout.write(JSON.stringify({dryRun:false,batches:1,inspected:2,candidates:1,rewritten:1,payloadBytesReclaimed:80,reclaim:{integrity:'ok',backupIntegrity:'ok',bytesReclaimed:40}})); }
}
`);
	fs.chmodSync(command, 0o755);
	const config = path.join(root, 'retention.json');
	fs.writeFileSync(config, JSON.stringify({ command, temp_roots: [temp], data_roots: [data] }));
	const env = { ...process.env, [CONFIG_ENV]: config, XDG_STATE_HOME: path.join(root, 'state') };
	const inventory = handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env, now: Date.now() });
	const session = (id) => inventory.items.find((entry) => entry.id === `session:${id}`);
	assert.equal(session('ses_unknown').ownership_known, false);
	assert.equal(session('ses_pinned').referenced, true);
	assert.equal(session('ses_owned').reconstructable, false);
	const compaction = inventory.items.find((entry) => entry.id.startsWith('compaction:'));
	assert.ok(compaction);
	const sessionReceipt = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: inventory.generation, reclaim_targets: [{ id: session('ses_owned').id, reclaim_token: session('ses_owned').reclaim_token }] }, { env });
	assert.deepEqual(sessionReceipt.reclaimed_item_ids, []);
	const receipt = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: inventory.generation, reclaim_targets: [{ id: compaction.id, reclaim_token: compaction.reclaim_token }] }, { env });
	assert.deepEqual(receipt.reclaimed_item_ids, [compaction.id]);
	assert.equal(receipt.logical_deleted_bytes, 80);
	assert.equal(receipt.verified_physical_file_bytes_reclaimed, 40);
	assert.equal(spawnSync('sqlite3', [database, "SELECT count(*) FROM session WHERE id='ses_owned'"], { encoding: 'utf8' }).stdout.trim(), '1');
	assert.equal(spawnSync('sqlite3', [database, "SELECT count(*) FROM event WHERE type='message.compacted.1'"], { encoding: 'utf8' }).stdout.trim(), '1');
	console.log('opencode native session retention: ok');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
