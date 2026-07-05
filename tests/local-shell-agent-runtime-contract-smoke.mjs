#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(rootDir, 'agent-runtimes', 'local-shell');
const manifestPath = path.join(runtimeDir, 'local-shell.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const provider = manifest.agent_task_executors[0];
const executorPath = path.join(runtimeDir, 'scripts', 'agent', 'local-shell-agent-task-executor.cjs');

assert.equal(manifest.schema, 'homeboy/agent-runtime-manifest/v1');
assert.equal(manifest.id, 'local-shell');
assert.equal(provider.schema, 'homeboy/agent-task-executor-provider/v1');
assert.equal(provider.backend, 'local-shell');
assert.match(provider.command, /\{\{runtime_path\}\}/);
assert.equal(provider.request_schema, 'homeboy/agent-task-request/v1');
assert.equal(provider.outcome_schema, 'homeboy/agent-task-outcome/v1');
assert.ok(provider.request_required_fields.includes('executor.config.command'));
assert.ok(provider.capabilities.includes('structured_outcome'));
assert.equal(provider.workspace_materialization.cwd, 'request_workspace');
assert.equal(provider.workspace_materialization.requires_git, false);
assert.equal(provider.workspace_materialization.write_scope, 'workspace');

function runExecutor(request) {
	const result = spawnSync('node', [executorPath], {
		input: JSON.stringify(request),
		encoding: 'utf8',
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '');
	return JSON.parse(result.stdout);
}

const success = runExecutor({
	schema: provider.request_schema,
	task_id: 'local-shell-success',
	executor: {
		backend: provider.backend,
		config: {
			command: process.execPath,
			args: ['-e', 'process.stdout.write("local-shell ok")'],
		},
	},
	instructions: 'Run a deterministic local command.',
});

assert.equal(success.schema, provider.outcome_schema);
assert.equal(success.task_id, 'local-shell-success');
assert.equal(success.status, 'succeeded');
assert.equal(success.metadata.provider, 'local-shell');
assert.equal(success.diagnostics[0].stdout, 'local-shell ok');

const failed = runExecutor({
	schema: provider.request_schema,
	task_id: 'local-shell-failure',
	executor: {
		backend: provider.backend,
		config: {
			command: process.execPath,
			args: ['-e', 'process.stderr.write("local-shell failed"); process.exit(7)'],
		},
	},
	instructions: 'Return a deterministic command failure.',
});

assert.equal(failed.status, 'failed');
assert.equal(failed.diagnostics[0].classification, 'execution_failed');
assert.equal(failed.diagnostics[0].exit_code, 7);
assert.equal(failed.diagnostics[0].stderr, 'local-shell failed');

const invalid = runExecutor({
	schema: provider.request_schema,
	task_id: 'local-shell-invalid',
	executor: {
		backend: provider.backend,
	},
	instructions: 'Missing command.',
});

assert.equal(invalid.status, 'provider_error');
assert.equal(invalid.diagnostics[0].classification, 'request_validation');

console.log('local-shell agent runtime contract smoke passed');
