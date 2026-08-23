'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CONFIG_ENV, PROVIDER_ID, SCHEMA, handleRequest, externalStorageRetentionProviderContract } = require('../lib/opencode-external-storage-retention');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-retention-'));
try {
	const temp = path.join(root, 'interactive-temp');
	const data = path.join(root, 'durable-data');
	const scratch = path.join(temp, 'terminal-scratch');
	const active = path.join(temp, 'active-scratch');
	const dead = path.join(temp, 'dead-owner-scratch');
	const unknown = path.join(temp, 'mixed-version-unmanaged');
	const output = path.join(data, 'tool-output', 'terminal-output');
	const snapshot = path.join(data, 'snapshot', 'pinned-export');
	const database = path.join(data, 'opencode.db');
	for (const directory of [scratch, active, dead, unknown, output, snapshot]) fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(scratch, 'payload'), '1234567');
	fs.writeFileSync(path.join(active, 'payload'), 'active');
	fs.writeFileSync(path.join(dead, 'payload'), 'dead');
	fs.writeFileSync(path.join(unknown, 'payload'), 'unknown');
	fs.writeFileSync(path.join(output, 'payload'), 'tool-output');
	fs.writeFileSync(path.join(snapshot, 'payload'), 'pinned');
	fs.writeFileSync(database, 'durable database');
	fs.writeFileSync(path.join(data, 'auth.json'), 'credential');
	for (const [directory, id] of [[scratch, 'scratch-terminal'], [active, 'scratch-active'], [dead, 'scratch-dead']]) {
		fs.writeFileSync(path.join(directory, '.homeboy-opencode-retention.json'), JSON.stringify({ id, class: 'scratch', managed: true, reconstructable: true, terminal_at: '2020-01-01T00:00:00Z', owner: directory === active ? { pid: process.pid } : { pid: 999999 } }));
	}
	const command = path.join(root, 'opencode-fixture.cjs');
	const commandLog = path.join(root, 'native-operations.log');
	fs.writeFileSync(command, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(commandLog)}, process.argv.slice(2).join(' ') + '\\n');\n`);
	fs.chmodSync(command, 0o755);
	const configPath = path.join(root, 'retention.json');
	fs.writeFileSync(configPath, JSON.stringify({
		temp_roots: [temp], data_root: data, command,
		resources: [
			{ id: 'scratch-terminal', path: scratch, class: 'scratch', managed: true, reconstructable: true, terminal_at: '2020-01-01T00:00:00Z', owner: { pid: 999999 } },
			{ id: 'scratch-active', path: active, class: 'scratch', managed: true, reconstructable: true, terminal_at: '2020-01-01T00:00:00Z', owner: { pid: process.pid } },
			{ id: 'scratch-dead', path: dead, class: 'scratch', managed: true, reconstructable: true, terminal_at: '2020-01-01T00:00:00Z', owner: { pid: 999999 } },
			{ id: 'tool-output', path: output, class: 'durable_artifact', managed: true, reconstructable: true, referenced: true, terminal_at: '2020-01-01T00:00:00Z' },
			{ id: 'pinned-export', path: snapshot, class: 'pinned_export', managed: true, reconstructable: true, pinned: true, terminal_at: '2020-01-01T00:00:00Z' },
			{ id: 'expired-session-store', path: database, class: 'session_store', managed: true, reconstructable: true, expired_session_ids: ['ses_expired'], terminal_at: '2020-01-01T00:00:00Z' },
		],
	}));
	const options = { env: { ...process.env, [CONFIG_ENV]: configPath }, now: Date.parse('2026-08-23T00:00:00Z') };
	const inventory = handleRequest({ schema: SCHEMA, operation: 'inventory' }, options);
	assert.equal(inventory.provider_id, PROVIDER_ID);
	assert.deepEqual(externalStorageRetentionProviderContract(), { id: PROVIDER_ID, command: ['homeboy-opencode-external-storage-retention'], timeout_seconds: 30 });
	assert.equal(inventory.items.find((item) => item.id === 'scratch-active').active, true);
	assert.equal(inventory.items.find((item) => item.id === 'tool-output').referenced, true);
	assert.equal(inventory.items.find((item) => item.id === 'pinned-export').referenced, true);
	assert.equal(inventory.items.find((item) => item.id === 'credential:auth.json').class, 'credential');
	assert.ok(inventory.unknown_bytes >= Buffer.byteLength('unknown'));
	for (const item of inventory.items) {
		assert.match(item.id, /^(?:scratch|tool|pinned|expired|credential|session-store)/);
		assert.equal(Number.isInteger(item.bytes), true);
		assert.match(item.reclaim_token, /^[a-f0-9]{64}$/);
		assert.match(item.locator, /^opencode:/);
	}
	const target = (id) => { const item = inventory.items.find((candidate) => candidate.id === id); return { id, reclaim_token: item.reclaim_token }; };
	const receipt = handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: inventory.generation, reclaim_targets: [target('scratch-terminal'), target('scratch-dead'), target('expired-session-store'), target('scratch-active'), target('tool-output'), target('pinned-export')] }, options);
	assert.deepEqual(receipt.reclaimed_item_ids, ['scratch-terminal', 'scratch-dead', 'expired-session-store']);
	assert.equal(receipt.reclaimed_bytes, inventory.items.find((item) => item.id === 'scratch-terminal').bytes + inventory.items.find((item) => item.id === 'scratch-dead').bytes);
	assert.equal(fs.existsSync(scratch), false);
	assert.equal(fs.existsSync(dead), false);
	assert.equal(fs.existsSync(active), true);
	assert.equal(fs.existsSync(output), true);
	assert.equal(fs.existsSync(snapshot), true);
	assert.equal(fs.existsSync(path.join(data, 'auth.json')), true);
	assert.equal(fs.existsSync(database), true);
	assert.deepEqual(fs.readFileSync(commandLog, 'utf8').trim().split('\n'), ['session delete ses_expired', 'db VACUUM']);
	assert.throws(() => handleRequest({ schema: SCHEMA, operation: 'reclaim', generation: inventory.generation, reclaim_targets: [target('scratch-dead')] }, options), /stale/);
	const script = path.join(__dirname, '..', 'scripts', 'agent', 'homeboy-opencode-external-storage-retention.cjs');
	const protocol = spawnSync(process.execPath, [script], { input: JSON.stringify({ schema: SCHEMA, operation: 'inventory' }), encoding: 'utf8', env: options.env });
	assert.equal(protocol.status, 0, protocol.stderr);
	assert.equal(JSON.parse(protocol.stdout).schema, SCHEMA);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
