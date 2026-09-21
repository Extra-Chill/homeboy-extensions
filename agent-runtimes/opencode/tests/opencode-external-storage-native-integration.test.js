'use strict';

// Run with HOMEBOY_OPENCODE_NATIVE_TEST_CONFIG pointing at a disposable
// retention config for the settled native CLI. This deliberately does not
// manufacture a native command or database fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { CONFIG_ENV, SCHEMA, handleRequest } = require('../lib/opencode-external-storage-retention');

const config = process.env.HOMEBOY_OPENCODE_NATIVE_TEST_CONFIG;
if (!config) {
	console.log('opencode native integration: skipped (HOMEBOY_OPENCODE_NATIVE_TEST_CONFIG is unset)');
} else {
	const value = JSON.parse(fs.readFileSync(config, 'utf8'));
	const env = { ...process.env, [CONFIG_ENV]: config };
	const dbPath = spawnSync(value.command || 'opencode', ['db', 'path'], { encoding: 'utf8', env });
	assert.equal(dbPath.status, 0, dbPath.stderr);
	const database = dbPath.stdout.trim();
	const inventory = handleRequest({ schema: SCHEMA, operation: 'inventory' }, { env });
	const compaction = inventory.items.find((item) => item.id.startsWith('compaction:'));
	assert.ok(compaction, 'native event-log status must expose an eligible compaction item');
	const before = spawnSync('sqlite3', [database, "SELECT count(*) || ':' || group_concat(type, ',') FROM event"], { encoding: 'utf8' });
	assert.equal(before.status, 0, before.stderr);
	const receipt = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: inventory.generation, reclaim_targets: [{ id: compaction.id, reclaim_token: compaction.reclaim_token }] }, { env });
	assert.deepEqual(Object.keys(receipt).sort(), ['generation', 'provider_id', 'reclaimed_bytes', 'reclaimed_item_ids', 'schema']);
	assert.deepEqual(receipt.reclaimed_item_ids, [compaction.id]);
	assert.equal(receipt.reclaimed_bytes, 0, 'bounded rewrite does not claim physical reclaim');
	const after = spawnSync('sqlite3', [database, "SELECT count(*) || ':' || group_concat(type, ',') FROM event"], { encoding: 'utf8' });
	assert.equal(after.status, 0, after.stderr);
	assert.equal(after.stdout.trim().split(':')[0], before.stdout.trim().split(':')[0], 'event history row count is preserved');
	console.log('opencode native integration: ok');
}
