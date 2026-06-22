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
const { codeboxDocsAgentRecipePlan } = require('../../lib/codebox-docs-agent-recipe-planner');

function argValue(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : '';
}

function argValues(name) {
	const values = [];
	for (let index = 0; index < process.argv.length; index += 1) {
		if (process.argv[index] === name && process.argv[index + 1]) {
			values.push(process.argv[index + 1]);
		}
	}
	return values;
}

function hasFlag(name) {
	return process.argv.includes(name);
}

function usage() {
	console.error('Usage: homeboy-codebox-docs-agent-recipe-plan.cjs --plan-id <id> (--recipe <json>|--recipe-file <file>|--recipe-pack <pack>|--recipe-name <name>|--recipe-path <path>|--recipe-repo <repo>) [--recipe-ref <ref>] [--recipe-inputs <json>] [--recipe-inputs-file <file>] [--target-ref <ref>] [--target-repo <repo>] [--expected-artifact <kind>] [--timeout-seconds <n>] [--concurrency <n>] [--source-ref <json>] [--metadata <json>] [--output <plan.json>]');
	process.exit(1);
}

function readJsonArg(value, label) {
	if (!value) {
		return undefined;
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${error.message}`);
	}
}

function readJsonFile(filePath, label) {
	if (!filePath) {
		return undefined;
	}
	return readJsonArg(fs.readFileSync(filePath, 'utf8'), label);
}

function writeJson(filePath, payload) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

const planId = argValue('--plan-id');
if (!planId || hasFlag('--help') || hasFlag('-h')) {
	usage();
}

try {
	const recipe = readJsonFile(argValue('--recipe-file'), 'recipe file')
		|| readJsonArg(argValue('--recipe'), 'recipe')
		|| undefined;
	const recipeInputs = readJsonFile(argValue('--recipe-inputs-file'), 'recipe inputs file')
		|| readJsonArg(argValue('--recipe-inputs'), 'recipe inputs')
		|| undefined;
	const plan = codeboxDocsAgentRecipePlan({
		planId,
		taskId: argValue('--task-id') || undefined,
		recipe,
		recipePack: argValue('--recipe-pack') || undefined,
		recipeName: argValue('--recipe-name') || undefined,
		recipeRef: argValue('--recipe-ref') || undefined,
		recipePath: argValue('--recipe-path') || undefined,
		recipeRepository: argValue('--recipe-repo') || undefined,
		recipeInputs,
		targetRef: argValue('--target-ref') || undefined,
		targetRepo: argValue('--target-repo') || undefined,
		targetPr: argValue('--target-pr') || undefined,
		targetBranch: argValue('--target-branch') || undefined,
		instructions: argValue('--instructions') || undefined,
		repo: argValue('--repo') || undefined,
		workspace: argValue('--workspace') || undefined,
		groupKey: argValue('--group-key') || undefined,
		expectedArtifacts: argValues('--expected-artifact'),
		secretEnv: argValues('--secret-env'),
		timeoutSeconds: argValue('--timeout-seconds') || undefined,
		concurrency: argValue('--concurrency') || undefined,
		sourceRefs: argValues('--source-ref').map((value) => readJsonArg(value, 'source ref')),
		metadata: readJsonArg(argValue('--metadata'), 'metadata') || undefined,
	});

	const output = argValue('--output');
	if (output) {
		writeJson(output, plan);
	}
	console.log(JSON.stringify(plan, null, 2));
} catch (error) {
	console.error(error && error.stack ? error.stack : String(error));
	process.exit(1);
}
