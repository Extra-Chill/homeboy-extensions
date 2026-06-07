#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

/**
 * External dependencies
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Internal dependencies
 */
const {
  agentTaskOutcomeFromCodeboxResult,
  codeboxTaskRequestFromAgentTaskRequest,
  providerContract,
} = require('../../lib/codebox-agent-task-executor');

const DEFAULT_CODEBOX_CORE_MODULE = '@automattic/wp-codebox-core';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readRequest() {
  const raw = process.env.HOMEBOY_AGENT_TASK_REQUEST || readStdin();
  if (!raw.trim()) {
    throw new Error('AgentTaskRequest JSON is required on stdin or HOMEBOY_AGENT_TASK_REQUEST.');
  }
  return JSON.parse(raw);
}

function requestTimeoutMs(request) {
  const timeoutMs = request?.limits?.timeout_ms || request?.limits?.max_runtime_ms;
  const timeoutSeconds = request?.limits?.task_timeout_seconds || request?.limits?.taskTimeoutSeconds;
  const timeout = timeoutMs || (timeoutSeconds ? Number.parseInt(timeoutSeconds, 10) * 1000 : undefined);
  const parsed = Number.parseInt(timeout, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function timeoutPayload(timeoutMs, request = {}) {
  const artifacts = argValue('--artifacts') || request.executor?.config?.artifacts || '';
  const evidencePath = artifacts ? `${artifacts}/homeboy-codebox-task-runner.json` : '';
  const knownArtifacts = [];
  if (artifacts) {
    knownArtifacts.push({
      id: 'homeboy-codebox-artifacts',
      kind: 'codebox-artifact-directory',
      path: artifacts,
      metadata: { evidencePath },
    });
  }
  if (evidencePath && fs.existsSync(evidencePath)) {
    knownArtifacts.push({
      id: 'homeboy-codebox-task-runner-preflight',
      kind: 'codebox-task-runner-preflight',
      path: evidencePath,
      metadata: { artifacts },
    });
  }
  const evidenceRefs = evidencePath && fs.existsSync(evidencePath) ? [{
    kind: 'codebox-task-runner-preflight',
    uri: evidencePath,
    label: 'WP Codebox task runner preflight evidence',
  }] : [];
  return {
    success: false,
    timeout: true,
    summary: `WP Codebox agent task timed out after ${timeoutMs}ms.`,
    artifacts: knownArtifacts,
    evidence_refs: evidenceRefs,
    diagnostics: [{
      class: 'codebox.timeout',
      message: 'Task runner exceeded the AgentTaskRequest timeout.',
      data: {
        timeout_ms: timeoutMs,
        classification: 'provider_timeout',
        artifacts,
        evidence_path: evidencePath,
        artifact_ref_count: knownArtifacts.length,
      },
    }],
    metadata: {
      timeout_ms: timeoutMs,
      timeout_classification: 'provider_timeout',
      artifacts,
      evidence_path: evidencePath,
      artifact_ref_count: knownArtifacts.length,
    },
  };
}

function redactDiagnosticText(text) {
  return String(text || '')
    .replace(/((?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|REFRESH[_-]?TOKEN)[A-Z0-9_-]*\s*=\s*)\S+/gi, '$1[redacted]')
    .slice(0, 8000);
}

function missingSecretEnvNames(stderr) {
  const match = String(stderr || '').match(/Required WP Codebox secret environment variable missing:\s*([^\n\r]+)/i);
  if (!match) {
    return [];
  }
  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Z0-9_]+$/.test(name));
}

function stderrFailurePayload(result) {
  const stderr = redactDiagnosticText(result.stderr || '');
  const missingSecretEnv = missingSecretEnvNames(stderr);
  const diagnosticClass = missingSecretEnv.length > 0
    ? 'codebox.preflight.missing_secret_env'
    : 'codebox.preflight.stderr';
  const message = missingSecretEnv.length > 0
    ? `WP Codebox task runner preflight is missing required secret environment variables: ${missingSecretEnv.join(', ')}.`
    : 'WP Codebox task runner failed before returning a JSON outcome.';

  return {
    success: false,
    status: 'failed',
    failure_classification: 'provider',
    summary: message,
    diagnostics: [{
      class: diagnosticClass,
      message,
      data: {
        phase: 'codebox.preflight',
        exit_status: result.status ?? 1,
        missing_env: missingSecretEnv,
        stderr,
      },
    }],
    metadata: {
      phase: 'codebox.preflight',
      exit_status: result.status ?? 1,
      missing_env: missingSecretEnv,
      stderr,
    },
  };
}

async function loadCodeboxCorePrimitives() {
  const configuredModule = process.env.HOMEBOY_WP_CODEBOX_CORE_MODULE;
  const candidates = configuredModule ? [configuredModule] : [DEFAULT_CODEBOX_CORE_MODULE];

  for (const candidate of candidates) {
    try {
      const module = await importModule(candidate);
      if (typeof module.normalizeAgentTaskRunResult === 'function' || typeof module.normalizeRecipeRunSummary === 'function') {
        return {
          normalizeAgentTaskRunResult: module.normalizeAgentTaskRunResult,
          normalizeRecipeRunSummary: module.normalizeRecipeRunSummary,
        };
      }
    } catch {
      // Codebox core is optional in local smoke tests that only exercise request shaping.
    }
  }

  return {};
}

function importModule(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
    return import(specifier.startsWith('file:') ? specifier : pathToFileURL(path.resolve(specifier)).href);
  }
  return import(specifier);
}

async function runTaskRunner(request) {
  const codeboxCore = await loadCodeboxCorePrimitives();
  const runner = argValue('--task-runner') || `${__dirname}/homeboy-wp-codebox-task-runner.cjs`;
  const config = request.executor?.config || {};
  const configArgs = [
    ['--agents-api', config.agents_api_path || config.agentsApiPath],
    ['--homeboy', config.homeboy_path || config.homeboyPath],
    ['--homeboy-extensions', config.homeboy_extensions_path || config.homeboyExtensionsPath],
  ].flatMap(([name, value]) => (value ? [name, value] : []));
  const args = process.argv.slice(2).filter((arg, index, all) => {
    if (arg === '--task-runner' || all[index - 1] === '--task-runner' || arg === '--print-contract') {
      return false;
    }
    return true;
  });
  const result = spawnSync(process.execPath, [runner, ...args, ...configArgs], {
    encoding: 'utf8',
    input: JSON.stringify(codeboxTaskRequestFromAgentTaskRequest(request)),
    env: process.env,
    maxBuffer: 1024 * 1024 * 20,
    timeout: requestTimeoutMs(request),
  });

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  let payload = {};
  if (result.error && result.error.code === 'ETIMEDOUT') {
    payload = timeoutPayload(requestTimeoutMs(request), request);
    return agentTaskOutcomeFromCodeboxResult(request, payload, { exitStatus: 1, ...codeboxCore });
  }
  if (result.stdout.trim()) {
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      payload = missingSecretEnvNames(result.stderr).length > 0 ? stderrFailurePayload(result) : {
        success: result.status === 0,
        summary: result.stdout.trim(),
        status: result.status === 0 ? 'succeeded' : 'failed',
        failure_classification: result.status === 0 ? undefined : 'provider',
        diagnostics: [{
          class: 'codebox.stdout',
          message: 'WP Codebox returned non-JSON stdout.',
          data: {
            phase: 'codebox.preflight',
            exit_status: result.status ?? 1,
            stderr: redactDiagnosticText(result.stderr || ''),
          },
        }],
        metadata: {
          phase: 'codebox.preflight',
          exit_status: result.status ?? 1,
          stderr: redactDiagnosticText(result.stderr || ''),
        },
      };
    }
  } else if ((result.status ?? 0) !== 0 || (result.stderr || '').trim()) {
    payload = stderrFailurePayload(result);
  }

  return agentTaskOutcomeFromCodeboxResult(request, payload, { exitStatus: result.status ?? 1, ...codeboxCore });
}

(async () => {
  try {
    if (hasFlag('--print-contract')) {
      process.stdout.write(`${JSON.stringify(providerContract(), null, 2)}\n`);
      process.exit(0);
    }

    const request = readRequest();
    const outcome = await runTaskRunner(request);
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    process.exitCode = outcome.status === 'succeeded' || outcome.status === 'no_op' ? 0 : 1;
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
})();
