'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openCodeProviderCapacity } = require('../lib/opencode-provider-capacity');
const { openCodeProviderReadiness } = require('..');
const fixtures = require('./fixtures/provider-capacity.json');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeboy-opencode-capacity-'));
fs.mkdirSync(path.join(root, 'opencode'), { recursive: true });
fs.writeFileSync(path.join(root, 'opencode', 'auth.json'), JSON.stringify({
	anthropic: { type: 'oauth', access: 'anthropic-access-secret', refresh: 'r', expires: 1 },
	openai: { type: 'oauth', access: 'openai-access-secret', refresh: 'r', expires: 1 },
	'zai-coding-plan': { type: 'api', key: 'zai-key-secret' },
	'opencode-go': { type: 'api', key: 'go-key-secret' },
}));
const env = { HOME: root, XDG_DATA_HOME: root, PATH: process.env.PATH };

function fetchReturning(body, status = 200, calls = []) {
	return async (url, init) => {
		calls.push({ url, init });
		return { ok: status >= 200 && status < 300, status, json: async () => body };
	};
}

async function run() {
	// Anthropic: tightest window is the 5-hour one; credential goes in a Bearer header.
	const anthropicCalls = [];
	const anthropic = await openCodeProviderCapacity('anthropic', { env, fetch: fetchReturning(fixtures.anthropic, 200, anthropicCalls) });
	assert.equal(anthropicCalls[0].url, 'https://api.anthropic.com/api/oauth/usage');
	assert.equal(anthropicCalls[0].init.headers.Authorization, 'Bearer anthropic-access-secret');
	assert.equal(anthropicCalls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
	assert.deepEqual(anthropic.capacity, { remaining: 96, limit: 100, unit: 'percent', reset_at: '2026-09-24T15:50:00.400Z' });
	assert.deepEqual(anthropic.windows.map((window) => window.name), ['five_hour', 'seven_day']);
	assert.equal(anthropic.exhausted, false);

	// OpenAI: an exhausted weekly window reports capacity 0 with its reset time.
	const openai = await openCodeProviderCapacity('openai', { env, fetch: fetchReturning(fixtures.openai_exhausted) });
	assert.deepEqual(openai.capacity, { remaining: 0, limit: 100, unit: 'percent', reset_at: '2026-09-28T23:29:35.000Z' });
	assert.equal(openai.windows[0].name, '7_day');
	assert.equal(openai.exhausted, true);

	// OpenAI: a blocked account is exhausted even when no window reads 100%.
	const blocked = await openCodeProviderCapacity('openai', { env, fetch: fetchReturning(fixtures.openai_blocked_below_full) });
	assert.equal(blocked.exhausted, true);

	// Z.ai: only token windows count; a window without nextResetTime has no reset_at.
	const zaiCalls = [];
	const zai = await openCodeProviderCapacity('zai-coding-plan', { env, fetch: fetchReturning(fixtures.zai, 200, zaiCalls) });
	assert.equal(zaiCalls[0].init.headers.Authorization, 'zai-key-secret');
	assert.deepEqual(zai.windows.map((window) => [window.name, window.used_percent, window.reset_at]), [
		['tokens_5_hour', 0, null],
		['tokens_1_week', 58, '2026-09-29T02:00:15.973Z'],
	]);
	assert.deepEqual(zai.capacity, { remaining: 42, limit: 100, unit: 'percent', reset_at: '2026-09-29T02:00:15.973Z' });

	// Providers without a usage endpoint, or without a credential, report nothing.
	let called = false;
	const noCall = async () => { called = true; };
	assert.equal(await openCodeProviderCapacity('opencode-go', { env, fetch: noCall }), null);
	assert.equal(await openCodeProviderCapacity('anthropic', { env: { HOME: path.join(root, 'missing') }, fetch: noCall }), null);
	assert.equal(called, false);

	// Lab runners provide OAuth access tokens through the store secret env.
	const envCalls = [];
	await openCodeProviderCapacity('openai', {
		env: { HOME: path.join(root, 'missing'), AI_PROVIDER_OPENCODE_OPENAI_ACCESS: 'env-access-secret' },
		fetch: fetchReturning(fixtures.openai_exhausted, 200, envCalls),
	});
	assert.equal(envCalls[0].init.headers.Authorization, 'Bearer env-access-secret');

	// Failures degrade to a diagnostic without leaking credentials.
	const httpFailure = await openCodeProviderCapacity('anthropic', { env, fetch: fetchReturning({}, 401) });
	assert.deepEqual(httpFailure, { diagnostic: 'anthropic usage lookup returned HTTP 401' });
	const networkFailure = await openCodeProviderCapacity('anthropic', { env, fetch: async () => { throw new Error('anthropic-access-secret'); } });
	assert.equal(networkFailure.diagnostic, 'anthropic usage lookup failed: request error');
	const unrecognized = await openCodeProviderCapacity('anthropic', { env, fetch: fetchReturning({ unexpected: true }) });
	assert.match(unrecognized.diagnostic, /no|did not include/);

	await readinessIntegration();
	console.log('opencode provider capacity tests passed');
}

async function readinessIntegration() {
	const executable = path.join(root, 'opencode-bin');
	fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	const request = {
		schema: 'homeboy/agent-task-provider-readiness-request/v1',
		effective_config: { runtime_bin: executable, model: 'openai/gpt-5.6-terra' },
	};
	const commands = [];
	const spawnSync = (command, args) => {
		commands.push(args);
		if (args.includes('--version')) return { status: 0, stdout: '1.0.0\n', stderr: '' };
		if (args.includes('auth')) return { status: 0, stdout: 'OpenAI oauth\n', stderr: '' };
		if (args.includes('models')) return { status: 0, stdout: 'openai/gpt-5.6-terra\n', stderr: '' };
		return { status: 0, stdout: '{"type":"text","text":"READY"}\n', stderr: '' };
	};

	// Exhausted plan: classified as capacity, skips the inference probe, carries the reset.
	const exhausted = await openCodeProviderReadiness(request, { env, spawnSync, fetch: fetchReturning(fixtures.openai_exhausted) });
	assert.equal(exhausted.ready, false);
	assert.equal(exhausted.classification, 'capacity');
	assert.equal(exhausted.reason, 'provider_capacity_exhausted');
	assert.equal(exhausted.capacity.reset_at, '2026-09-28T23:29:35.000Z');
	assert.ok(!commands.some((args) => args.includes('run')));
	assert.ok(!JSON.stringify(exhausted).includes('openai-access-secret'));

	// Healthy plan: ready verdict gains capacity; the model probe still runs.
	commands.length = 0;
	const ready = await openCodeProviderReadiness(request, { env, spawnSync, fetch: fetchReturning(fixtures.openai_available) });
	assert.equal(ready.classification, 'ready');
	assert.deepEqual(ready.capacity, { remaining: 88, limit: 100, unit: 'percent', reset_at: '2026-09-28T23:29:35.000Z' });
	assert.ok(commands.some((args) => args.includes('run')));

	// Failed lookup: readiness is unchanged and the diagnostic is attached.
	const degraded = await openCodeProviderReadiness(request, { env, spawnSync, fetch: fetchReturning({}, 503) });
	assert.equal(degraded.classification, 'ready');
	assert.equal(degraded.capacity, undefined);
	assert.equal(degraded.capacity_diagnostic, 'openai usage lookup returned HTTP 503');
}

run().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
	console.error(error);
	process.exit(1);
});
