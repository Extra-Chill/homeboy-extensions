'use strict';

/**
 * External dependencies
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Internal dependencies
 */
const {
	OPENCODE_SECRET_ENV,
	experimentalOutcome,
	providerContract,
} = require('../../ai-runtimes/opencode');

function secretEnvRequirementForProvider(contract, provider) {
	return contract.secret_env_requirements.find((requirement) => (
		requirement.when.any.some((selector) => selector.path === 'executor.config.provider' && selector.equals === provider)
	));
}

const provider = providerContract();
assert.equal(provider.id, 'opencode.agent-task-executor');
assert.equal(provider.backend, 'opencode');
assert.equal(provider.status, 'experimental');
assert.equal(provider.integration_contract, 'homeboy-opencode-agent-task/v1');
assert.equal(provider.lifecycle.max_concurrency_default, 1);
assert.equal(provider.lifecycle.cancellation, 'provider_signal');
assert.deepEqual(secretEnvRequirementForProvider(provider, 'codex').env, OPENCODE_SECRET_ENV);
assert.deepEqual(provider.provider_defaults.codex.secret_env, OPENCODE_SECRET_ENV);
assert.equal(provider.provider_defaults.codex.model, 'gpt-5.5');
assert.equal(provider.redacted_metadata_keys.includes('opencode_auth'), true);
assert.equal(provider.capabilities.includes('repo_workspace'), true);
assert.equal(provider.capabilities.includes('patch_artifacts'), true);
assert.equal(provider.capabilities.includes('browser_runtime'), false);

const runtimePath = path.join(__dirname, '..', '..', 'ai-runtimes', 'opencode');
const manifest = JSON.parse(fs.readFileSync(path.join(runtimePath, 'opencode.json'), 'utf8'));
assert.equal(manifest.id, 'opencode');
assert.equal(manifest.agent_task_executors.length, 1);
assert.deepEqual(manifest.agent_task_executors[0], providerContract());

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeboy-opencode-provider-contract-'));
try {
	const runtimesRoot = path.join(root, 'ai-runtimes');
	const linkedRuntimePath = path.join(runtimesRoot, 'opencode');
	fs.mkdirSync(runtimesRoot, { recursive: true });
	fs.symlinkSync(runtimePath, linkedRuntimePath, 'dir');

	const command = manifest.agent_task_executors[0].command.replaceAll('{{runtime_path}}', linkedRuntimePath);
	const [, scriptPath] = command.match(/^node\s+(.+)$/) || [];
	assert(scriptPath, 'provider command should be a node script command');
	assert.equal(
		path.normalize(scriptPath),
		path.join(linkedRuntimePath, 'scripts', 'agent', 'homeboy-opencode-agent-task-executor.cjs')
	);
	assert.equal(fs.existsSync(scriptPath), true, `provider command target should exist: ${scriptPath}`);

	const contractResult = spawnSync(process.execPath, [scriptPath, '--provider-contract'], { encoding: 'utf8' });
	assert.equal(contractResult.status, 0, contractResult.stderr);
	assert.deepEqual(JSON.parse(contractResult.stdout), providerContract());

	const runResult = spawnSync(process.execPath, [scriptPath], {
		encoding: 'utf8',
		input: JSON.stringify({
			schema: 'homeboy/agent-task-request/v1',
			task_id: 'opencode-contract-only',
			executor: { backend: 'opencode', config: { provider: 'codex' } },
			instructions: 'Prove the OpenCode provider boundary without running a model.',
		}),
	});
	assert.notEqual(runResult.status, 0, 'experimental provider should fail fast until execution is implemented');
	assert.deepEqual(JSON.parse(runResult.stdout), experimentalOutcome({ task_id: 'opencode-contract-only' }));
	assert.equal(`${runResult.stdout}\n${runResult.stderr}`.includes('AI_PROVIDER_OPENAI_CODEX_REFRESH_TOKEN'), false);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write('OpenCode agent task executor boundary passed\n');
