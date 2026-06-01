'use strict';

/**
 * External dependencies
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const REQUEST_SCHEMA = 'homeboy/agent-task-request/v1';
const OUTCOME_SCHEMA = 'homeboy/agent-task-outcome/v1';
const REPORT_SCHEMA = 'homeboy/agent-task-report/v1';
const DEFAULT_TIMEOUT_SECONDS = 45 * 60;
const SECRET_KEY_PATTERN = /(secret|token|password|passwd|authorization|cookie|nonce|api[_-]?key|access[_-]?key|private[_-]?key|bearer)/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== '')
  );
}

function normalizeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
}

function redact(value, secretValues = [], key = '') {
  if (SECRET_KEY_PATTERN.test(key)) {
    return '[redacted]';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, secretValues));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, secretValues, entryKey)]));
  }
  if (typeof value === 'string') {
    let redacted = value.replace(/(bearer|token|api[_-]?key|password|cookie|authorization|private[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]');
    for (const secretValue of secretValues) {
      if (secretValue) {
        redacted = redacted.split(secretValue).join('[redacted]');
      }
    }
    return redacted;
  }
  return value;
}

function providerCredentialEnv(provider) {
  if (provider === 'opencode') {
    return ['OPENCODE_API_KEY'];
  }
  if (provider === 'codex') {
    return ['CODEX_API_KEY', 'OPENAI_API_KEY'];
  }
  return [];
}

function requestCredentialEnv(request) {
  const declared = normalizeList(request.secret_env || request.credentials?.secret_env || request.credentials?.env);
  if (declared.length > 0) {
    return declared;
  }
  return providerCredentialEnv(normalizeProvider(request.provider));
}

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!['opencode', 'codex'].includes(normalized)) {
    throw new Error(`Unsupported agent-task provider: ${provider || '(empty)'}`);
  }
  return normalized;
}

function validateRequest(request) {
  if (!request || request.schema !== REQUEST_SCHEMA) {
    throw new Error(`Agent task request must use schema ${REQUEST_SCHEMA}.`);
  }
  const provider = normalizeProvider(request.provider);
  const prompt = String(request.task?.prompt || request.prompt || '').trim();
  if (!prompt) {
    throw new Error('Agent task request must include task.prompt or prompt.');
  }
  const workspacePath = request.workspace?.path || request.worktree_path || request.repo_path || process.cwd();
  if (!workspacePath || !fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) {
    throw new Error(`Agent task workspace path is not a directory: ${workspacePath || '(empty)'}`);
  }
  return {
    provider,
    prompt,
    workspacePath: fs.realpathSync(workspacePath),
  };
}

function requiredSecretsAvailable(request, env = process.env) {
  const names = requestCredentialEnv(request);
  const missing = [];
  if (normalizeProvider(request.provider) === 'codex' && names.includes('CODEX_API_KEY') && names.includes('OPENAI_API_KEY')) {
    if (!env.CODEX_API_KEY && !env.OPENAI_API_KEY) {
      missing.push('CODEX_API_KEY or OPENAI_API_KEY');
    }
    return { names, missing };
  }
  for (const name of names) {
    if (!env[name]) {
      missing.push(name);
    }
  }
  return { names, missing };
}

function commandForRequest(request, prompt) {
  const provider = normalizeProvider(request.provider);
  const executable = request.executable || request.command || provider;
  const model = String(request.model || '').trim();
  const extraArgs = normalizeList(request.args);
  const args = provider === 'codex' ? ['exec'] : ['run'];
  if (model) {
    args.push('--model', model);
  }
  args.push(...extraArgs, prompt);
  return { executable, args };
}

function runGitDiff(workspacePath) {
  const result = spawnSync('git', ['diff', '--binary'], {
    cwd: workspacePath,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status !== 0) {
    return '';
  }
  return result.stdout || '';
}

function classifyFailure(command, output) {
  if (command.cancelled) {
    return { failure_class: 'cancelled', retryable: true };
  }
  if (command.timed_out) {
    return { failure_class: 'timeout', retryable: true };
  }
  const combined = `${output.stdout || ''}\n${output.stderr || ''}\n${command.error?.message || ''}`.toLowerCase();
  if (combined.match(/rate.?limit|429|temporarily unavailable|overloaded/)) {
    return { failure_class: 'provider_rate_limited', retryable: true };
  }
  if (combined.match(/unauthori[sz]ed|forbidden|invalid api key|api key.*missing|authentication|permission denied/)) {
    return { failure_class: 'provider_auth', retryable: false };
  }
  if (combined.match(/network|econnreset|enotfound|etimedout|tls handshake|socket hang up/)) {
    return { failure_class: 'provider_transport', retryable: true };
  }
  if (command.error) {
    return { failure_class: 'process_error', retryable: false };
  }
  return { failure_class: 'agent_failed', retryable: false };
}

function artifactEntry(filePath, type, title) {
  const content = fs.readFileSync(filePath);
  return {
    type,
    title,
    path: filePath,
    bytes: content.length,
    sha256: sha256(content),
  };
}

function outcomeFailureMessage(command, output) {
  if (command.error) {
    return command.error.message;
  }
  if (command.timed_out) {
    return `Agent task timed out after ${command.timeout_seconds} seconds`;
  }
  if (command.cancelled) {
    return 'Agent task was cancelled.';
  }
  if (command.signal) {
    return `Agent task exited from signal ${command.signal}`;
  }
  const stderr = String(output.stderr || '').trim();
  if (stderr) {
    return stderr.split('\n').slice(-1)[0];
  }
  return `Agent task exited with code ${command.exit_code}`;
}

function cancellationRequested(request) {
  const cancelFile = request.cancel_file || request.cancellation?.file || request.cancellation_file;
  return Boolean(cancelFile && fs.existsSync(cancelFile));
}

function spawnAgent(command, request, options) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const timeoutSeconds = Number(request.timeout_seconds || request.limits?.timeout_seconds || options.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let killedProcessGroup = false;
    const child = spawn(command.executable, command.args, {
      cwd: options.workspacePath,
      env: options.env || process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killChild = (signal = 'SIGTERM') => {
      killedProcessGroup = true;
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        child.kill(signal);
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, Math.max(1, timeoutSeconds) * 1000);

    const pollCancel = setInterval(() => {
      if (cancellationRequested(request)) {
        cancelled = true;
        killChild();
      }
    }, 250);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      clearInterval(pollCancel);
      resolve({
        command: compactObject({ ...command, error, timed_out: timedOut, cancelled, timeout_seconds: timeoutSeconds, killed_process_group: killedProcessGroup }),
        output: { stdout, stderr },
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      clearInterval(pollCancel);
      resolve({
        command: compactObject({ ...command, exit_code: exitCode, signal, timed_out: timedOut, cancelled, timeout_seconds: timeoutSeconds, killed_process_group: killedProcessGroup }),
        output: { stdout, stderr },
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    });
  });
}

async function executeAgentTask(request, options = {}) {
  const normalized = validateRequest(request);
  const credentialEnv = requiredSecretsAvailable(request, options.env || process.env);
  const artifactRoot = options.artifactRoot || request.artifact_dir || fs.mkdtempSync(path.join(os.tmpdir(), 'homeboy-agent-task-'));
  const artifactDir = path.join(artifactRoot, request.id || `${normalized.provider}-${Date.now()}`);
  const redactionSummary = {
    credential_env: credentialEnv.names,
    credentials_redacted: true,
  };
  fs.mkdirSync(artifactDir, { recursive: true });

  if (credentialEnv.missing.length > 0) {
    return {
      schema: OUTCOME_SCHEMA,
      request_id: request.id || '',
      provider: normalized.provider,
      model: request.model || '',
      status: 'failed',
      success: false,
      failure_class: 'credential_missing',
      retryable: false,
      failure: `Required agent-task credential environment variable missing: ${credentialEnv.missing.join(', ')}`,
      artifacts: [],
      redaction: redactionSummary,
    };
  }

  const secretValues = credentialEnv.names.map((name) => (options.env || process.env)[name]).filter(Boolean);
  const command = commandForRequest(request, normalized.prompt);
  const result = await spawnAgent(command, request, {
    env: options.env || process.env,
    workspacePath: normalized.workspacePath,
    timeoutSeconds: options.timeoutSeconds,
  });
  const redactedOutput = redact(result.output, secretValues);
  const redactedCommand = redact(result.command, secretValues);
  const patch = runGitDiff(normalized.workspacePath);
  const patchPath = path.join(artifactDir, 'patch.diff');
  const reportPath = path.join(artifactDir, 'report.json');
  const success = result.command.exit_code === 0 && !result.command.timed_out && !result.command.cancelled;
  const failure = success ? { failure_class: 'none', retryable: false } : classifyFailure(result.command, redactedOutput);
  const report = {
    schema: REPORT_SCHEMA,
    request: redact({
      id: request.id || '',
      task: request.task || {},
      provider: normalized.provider,
      model: request.model || '',
      workspace: { path: normalized.workspacePath },
    }, secretValues),
    command: redactedCommand,
    output: redactedOutput,
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    redaction: redactionSummary,
  };

  fs.writeFileSync(patchPath, patch);
  writeJson(reportPath, report);

  return compactObject({
    schema: OUTCOME_SCHEMA,
    request_id: request.id || '',
    provider: normalized.provider,
    model: request.model || '',
    status: success ? 'completed' : 'failed',
    success,
    failure_class: failure.failure_class,
    retryable: failure.retryable,
    failure: success ? '' : outcomeFailureMessage(result.command, redactedOutput),
    artifacts: [
      artifactEntry(patchPath, 'patch', 'Workspace patch'),
      artifactEntry(reportPath, 'report', 'Agent task execution report'),
    ],
    patch: {
      available: patch.length > 0,
      bytes: Buffer.byteLength(patch),
      sha256: sha256(patch),
    },
    failure_metadata: success ? undefined : compactObject({
      exit_code: result.command.exit_code,
      signal: result.command.signal,
      timed_out: result.command.timed_out,
      cancelled: result.command.cancelled,
      timeout_seconds: result.command.timeout_seconds,
      killed_process_group: result.command.killed_process_group,
    }),
    redaction: report.redaction,
  });
}

async function executeAgentTaskBatch(requests, options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency || 1));
  const outcomes = new Array(requests.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < requests.length) {
      const current = nextIndex;
      nextIndex += 1;
      outcomes[current] = await executeAgentTask(requests[current], options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()));
  return outcomes;
}

module.exports = {
  REQUEST_SCHEMA,
  OUTCOME_SCHEMA,
  REPORT_SCHEMA,
  commandForRequest,
  executeAgentTask,
  executeAgentTaskBatch,
  readJson,
  redact,
  requiredSecretsAvailable,
};
