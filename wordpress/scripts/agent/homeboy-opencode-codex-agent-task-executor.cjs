#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

/**
 * External dependencies
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Internal dependencies
 */
const { executeAgentTask } = require('../../lib/opencode-codex-agent-task-executor');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
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
    throw new Error('Agent task request JSON is required on stdin or HOMEBOY_AGENT_TASK_REQUEST.');
  }
  return JSON.parse(raw);
}

async function main() {
  const request = readRequest();
  if (argValue('--provider')) {
    request.provider = argValue('--provider');
  }
  if (argValue('--model')) {
    request.model = argValue('--model');
  }
  if (argValue('--agent-bin')) {
    request.executable = argValue('--agent-bin');
  }
  if (argValue('--artifacts')) {
    request.artifact_dir = path.resolve(argValue('--artifacts'));
  }
  const outcome = await executeAgentTask(request);
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exitCode = outcome.success ? 0 : 1;
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exitCode = 1;
});
