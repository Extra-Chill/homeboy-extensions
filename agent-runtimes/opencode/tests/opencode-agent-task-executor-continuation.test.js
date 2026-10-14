'use strict';

require('../../../runtime-agent-ci/tests/helpers/runtime-contract-constants-fixture.cjs');

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
const { executeOpenCodeAgentTask } = require('..');

(async () => {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeboy-opencode-continuation-'));
try {
	// Each test gets a pristine git workspace; paths inside the fixture CLI
	// templates are baked at write time.
	const setupWorkspace = (label) => {
		const workspace = path.join(root, `workspace-${label}`);
		fs.mkdirSync(workspace, { recursive: true });
		spawnSync('git', ['init'], { cwd: workspace, encoding: 'utf8' });
		spawnSync('git', ['commit', '--allow-empty', '-m', 'initial'], {
			cwd: workspace,
			encoding: 'utf8',
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'Homeboy Test',
				GIT_AUTHOR_EMAIL: 'homeboy@example.test',
				GIT_COMMITTER_NAME: 'Homeboy Test',
				GIT_COMMITTER_EMAIL: 'homeboy@example.test',
			},
		});
		return fs.realpathSync(workspace);
	};
	const baseWorkspace = setupWorkspace('base');
	const artifactsPath = path.join(root, 'artifacts');
	const fixtureEnv = {
		...process.env,
		AI_PROVIDER_OPENAI_CODEX_REFRESH_TOKEN: 'refresh-token-must-not-leak',
		AI_PROVIDER_OPENAI_CODEX_ACCESS_TOKEN: 'access-token-must-not-leak',
		XDG_STATE_HOME: path.join(root, 'private-runtime-state'),
	};

	const request = (taskId, overrides = {}) => {
		const ws = overrides.workspace || baseWorkspace;
		return {
			schema: 'homeboy/agent-task-request/v1',
			task_id: taskId,
			executor: {
				backend: 'opencode',
				runtime: 'opencode',
				secret_env: [
					'AI_PROVIDER_OPENAI_CODEX_REFRESH_TOKEN',
					'AI_PROVIDER_OPENAI_CODEX_ACCESS_TOKEN',
				],
				config: {
					provider: 'codex',
					runtime_bin: process.execPath,
					command_args: [overrides.cliPath || ''],
					...(overrides.config || {}),
					workspace_root: ws,
				},
			},
			policy: { write: 'patch' },
			workspace: { root: ws },
			expected_artifacts: ['patch', 'transcript', 'agent_result'],
			...(overrides.request || {}),
			instructions: 'Make the required change with a regression test.',
			artifacts_path: artifactsPath,
		};
	};

	const runMarker = path.join(root, 'runs');
	const patchArtifact = (result) => result.artifacts.find((artifact) => artifact.name === 'patch');

	// (i) Turn 0 abstains from editing entirely; the continuation turn edits.
	{
		const ws = setupWorkspace('empty-change');
		const cliPath = path.join(root, 'mock-continuation-empty-change.cjs');
		fs.writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const record = (turn) => fs.appendFileSync(${JSON.stringify(runMarker)}, turn + '\\n');
if (process.argv.includes('--session')) {
  record('continuation');
  const message = process.argv.at(-1);
  if (!message.includes('unchanged from its starting revision')) process.exit(3);
  if (!message.includes('intentional_no_change declaration naming that blocker')) process.exit(4);
  fs.writeFileSync(path.join(${JSON.stringify(ws)}, 'fix.txt'), 'fixed\\n');
  process.stdout.write(JSON.stringify({
    type: 'text',
    part: { type: 'text', text: 'You are right; making the change now.', metadata: { openai: { phase: 'final_answer' } } },
  }) + '\\n');
} else {
  record('turn0');
  process.stdout.write(JSON.stringify({
    type: 'text',
    part: { type: 'text', text: 'Turn complete, but nothing changed.', metadata: { openai: { phase: 'final_answer' } } },
  }) + '\\n');
}
process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_15880_fixture' }) + '\\n');
`);
		const result = await executeOpenCodeAgentTask(request('opencode-continuation-empty-change', {
			cliPath,
			workspace: ws,
		}), { env: fixtureEnv });
		assert.equal(result.status, 'succeeded', JSON.stringify(result.diagnostics));
		assert.equal(patchArtifact(result).bytes > 0, true, 'the continuation edit must produce a non-empty patch');
		assert.equal(fs.readFileSync(runMarker, 'utf8'), 'turn0\ncontinuation\n');
		assert.deepEqual(result.metadata.opencode_continuations, [
			{ turn: 1, gaps: ['empty_change'], session_id: 'ses_15880_fixture', exit_status: 0 },
		]);
	}

	// (ii) Turn 0 edits but omits review_form; the continuation returns it.
	{
		const ws = setupWorkspace('missing-form');
		const statePath = path.join(root, 'runs-missing-form.log');
		const cliPath = path.join(root, 'mock-continuation-missing-form.cjs');
		const reviewForm = {
			summary: 'Candidate reviewed after the fix.',
			what_changed: ['Added the fix.'],
			compatibility: 'No compatibility impact.',
			used_for: 'Pull request review.',
		};
		fs.writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const record = (turn) => fs.appendFileSync(${JSON.stringify(statePath)}, turn + '\\n');
if (process.argv.includes('--session')) {
  record('continuation');
  const message = process.argv.at(-1);
  if (!message.includes('missing required output(s): review_form')) process.exit(3);
  if (message.includes('unchanged from its starting revision')) process.exit(4);
  process.stdout.write(JSON.stringify({
    type: 'text',
    part: { type: 'text', text: 'Your fix is in the workspace.\\n\\n\`\`\`json\\n' + JSON.stringify({ outputs: { review_form: ${JSON.stringify(reviewForm)} } }) + '\\n\`\`\`', metadata: { openai: { phase: 'final_answer' } } },
  }) + '\\n');
} else {
  record('turn0');
  fs.writeFileSync(path.join(${JSON.stringify(ws)}, 'authored-fix.txt'), 'fix\\n');
  process.stdout.write(JSON.stringify({
    type: 'text',
    part: { type: 'text', text: 'Completed the change, but forgot the review form.', metadata: { openai: { phase: 'final_answer' } } },
  }) + '\\n');
}
process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_15880_form' }) + '\\n');
`);
		const result = await executeOpenCodeAgentTask(request('opencode-continuation-missing-form', {
			cliPath,
			workspace: ws,
			request: {
				output_declarations: [{
					name: 'review_form',
					required: true,
					schema: 'homeboy/agent-task-review-form/v1',
					structural_schema: {
						type: 'object',
						required: ['summary', 'what_changed', 'compatibility', 'used_for'],
					},
				}],
			},
		}), { env: fixtureEnv });
		assert.equal(result.status, 'succeeded', JSON.stringify(result.diagnostics));
		assert.deepEqual(result.outputs.review_form, reviewForm);
		assert.equal(fs.readFileSync(statePath, 'utf8'), 'turn0\ncontinuation\n');
		assert.deepEqual(result.metadata.opencode_continuations, [
			{ turn: 1, gaps: ['missing_outputs:review_form'], session_id: 'ses_15880_form', exit_status: 0 },
		]);
	}

	// (iii) A zero continuation budget keeps the pre-#15880 behaviour: one turn,
	// no session continuation, and the synthesized no-change success path.
	{
		fs.writeFileSync(runMarker, '');
		const cliPath = path.join(root, 'mock-continuation-budget-zero.cjs');
		fs.copyFileSync(path.join(root, 'mock-continuation-empty-change.cjs'), cliPath);
		const result = await executeOpenCodeAgentTask(request('opencode-continuation-budget-zero', {
			cliPath,
			config: { max_continuation_turns: 0 },
		}), { env: fixtureEnv });
		assert.equal(result.status, 'succeeded', JSON.stringify(result.diagnostics));
		assert.equal(patchArtifact(result).bytes, 0);
		assert.equal(fs.readFileSync(runMarker, 'utf8'), 'turn0\n');
		assert.equal(result.metadata.opencode_continuations, undefined);
	}

	// (iv) A model-declared intentional_no_change satisfies the change contract;
	// the executor must not nudge an unchanged checkout in that case.
	{
		fs.writeFileSync(runMarker, '');
		const cliPath = path.join(root, 'mock-continuation-declared-no-change.cjs');
		fs.writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const record = (turn) => fs.appendFileSync(${JSON.stringify(runMarker)}, turn + '\\n');
if (process.argv.includes('--session')) {
  record('continuation');
}
record('turn0');
process.stdout.write(JSON.stringify({ type: 'step_start', sessionID: 'ses_15880_no_change' }) + '\\n');
process.stdout.write(JSON.stringify({
  type: 'text',
  part: { type: 'text', text: 'The change is out of scope.\\n\\n\`\`\`json\\n' + JSON.stringify({ outputs: { intentional_no_change: { verdict: 'blocked', blocker: 'upstream schema migration' } } }) + '\\n\`\`\`', metadata: { openai: { phase: 'final_answer' } } },
}) + '\\n');
`);
		const result = await executeOpenCodeAgentTask(request('opencode-continuation-declared-no-change', { cliPath }), { env: fixtureEnv });
		assert.equal(result.status, 'succeeded', JSON.stringify(result.diagnostics));
		assert.equal(patchArtifact(result).bytes, 0);
		assert.equal(fs.readFileSync(runMarker, 'utf8'), 'turn0\n');
		assert.equal(result.metadata.opencode_continuations, undefined);
	}

	console.log('OpenCode agent task executor continuation passed');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
})();
