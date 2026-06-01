'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  commandForRequest,
  executeAgentTask,
  executeAgentTaskBatch,
  readJson,
  requiredSecretsAvailable,
} = require('../lib/opencode-codex-agent-task-executor');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
    input: options.input,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function writeFixtureAgent(root, name, source) {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n'use strict';\n${source}\n`);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function createRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  run('git', ['init'], { cwd: repo });
  run('git', ['config', 'user.name', 'Homeboy Fixture'], { cwd: repo });
  run('git', ['config', 'user.email', 'homeboy-fixture@example.com'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'before\n');
  run('git', ['add', 'README.md'], { cwd: repo });
  run('git', ['commit', '-m', 'Initial fixture'], { cwd: repo });
  return repo;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeboy-opencode-codex-agent-task-'));
  try {
    const repo = createRepo(root);
    const artifactRoot = path.join(root, 'artifacts');
    const fixtureAgent = writeFixtureAgent(root, 'fixture-agent.js', `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.cwd(), 'README.md'), 'after\\n');
process.stdout.write('agent used token=' + process.env.OPENCODE_API_KEY + '\\n');
process.stderr.write('authorization: Bearer ' + process.env.OPENCODE_API_KEY + '\\n');
`);
    const request = {
      schema: 'homeboy/agent-task-request/v1',
      id: 'request-opencode-success',
      provider: 'opencode',
      model: 'opencode-go/kimi-k2.6',
      executable: fixtureAgent,
      secret_env: ['OPENCODE_API_KEY'],
      workspace: { path: repo },
      task: {
        title: 'Update README',
        prompt: 'Change README.md.',
      },
    };

    const command = commandForRequest(request, request.task.prompt);
    assert.equal(command.executable, fixtureAgent);
    assert.deepEqual(command.args.slice(0, 3), ['run', '--model', 'opencode-go/kimi-k2.6']);

    const outcome = await executeAgentTask(request, {
      artifactRoot,
      env: { ...process.env, OPENCODE_API_KEY: 'fixture-secret-value' },
    });
    assert.equal(outcome.schema, 'homeboy/agent-task-outcome/v1');
    assert.equal(outcome.success, true);
    assert.equal(outcome.failure_class, 'none');
    assert.equal(outcome.patch.available, true);
    const patchArtifact = outcome.artifacts.find((artifact) => artifact.type === 'patch');
    const reportArtifact = outcome.artifacts.find((artifact) => artifact.type === 'report');
    assert.ok(patchArtifact);
    assert.ok(reportArtifact);
    assert.match(fs.readFileSync(patchArtifact.path, 'utf8'), /after/);
    const report = readJson(reportArtifact.path);
    assert.equal(report.output.stdout.includes('fixture-secret-value'), false);
    assert.equal(report.output.stderr.includes('fixture-secret-value'), false);
    assert.match(report.output.stdout, /\[redacted\]/);
    assert.match(report.output.stderr, /\[redacted\]/);

    const missing = await executeAgentTask(request, {
      artifactRoot,
      env: { ...process.env, OPENCODE_API_KEY: '' },
    });
    assert.equal(missing.success, false);
    assert.equal(missing.failure_class, 'credential_missing');
    assert.equal(missing.failure.includes('fixture-secret-value'), false);

    const failingAgent = writeFixtureAgent(root, 'fixture-rate-limit.js', `
process.stderr.write('Provider returned 429 rate limit for token=' + process.env.CODEX_API_KEY + '\\n');
process.exit(2);
`);
    const codexRequest = {
      ...request,
      id: 'request-codex-rate-limit',
      provider: 'codex',
      model: 'gpt-5.5',
      executable: failingAgent,
      secret_env: ['CODEX_API_KEY'],
    };
    assert.deepEqual(commandForRequest(codexRequest, codexRequest.task.prompt).args.slice(0, 3), ['exec', '--model', 'gpt-5.5']);
    const failed = await executeAgentTask(codexRequest, {
      artifactRoot,
      env: { ...process.env, CODEX_API_KEY: 'codex-secret-value' },
    });
    assert.equal(failed.success, false);
    assert.equal(failed.failure_class, 'provider_rate_limited');
    assert.equal(failed.retryable, true);
    const failedReport = readJson(failed.artifacts.find((artifact) => artifact.type === 'report').path);
    assert.equal(failedReport.output.stderr.includes('codex-secret-value'), false);

    const codexDefaultSecrets = requiredSecretsAvailable({ ...codexRequest, secret_env: [] }, { ...process.env, CODEX_API_KEY: '', OPENAI_API_KEY: 'openai-secret' });
    assert.deepEqual(codexDefaultSecrets.missing, []);

    const batch = await executeAgentTaskBatch([missing, missing].map((entry, index) => ({
      schema: 'homeboy/agent-task-request/v1',
      id: `batch-${index}`,
      provider: 'opencode',
      executable: fixtureAgent,
      secret_env: ['OPENCODE_API_KEY'],
      workspace: { path: repo },
      task: { prompt: entry.failure || 'batch prompt' },
    })), {
      artifactRoot,
      concurrency: 2,
      env: { ...process.env, OPENCODE_API_KEY: 'batch-secret' },
    });
    assert.equal(batch.length, 2);
    assert.equal(batch.every((entry) => entry.schema === 'homeboy/agent-task-outcome/v1'), true);

    const cliResult = spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'agent', 'homeboy-opencode-codex-agent-task-executor.cjs'),
      '--agent-bin',
      fixtureAgent,
      '--artifacts',
      artifactRoot,
    ], {
      cwd: repo,
      encoding: 'utf8',
      input: JSON.stringify({ ...request, id: 'cli-request' }),
      env: { ...process.env, OPENCODE_API_KEY: 'cli-secret-value' },
    });
    assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
    const cliOutcome = JSON.parse(cliResult.stdout);
    assert.equal(cliOutcome.request_id, 'cli-request');
    const cliReport = readJson(cliOutcome.artifacts.find((artifact) => artifact.type === 'report').path);
    assert.equal(JSON.stringify(cliReport).includes('cli-secret-value'), false);

    console.log('OpenCode/Codex agent-task executor smoke passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
