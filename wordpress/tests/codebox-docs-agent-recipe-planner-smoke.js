'use strict';

/**
 * External dependencies
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Internal dependencies
 */
const {
	codeboxDocsAgentRecipePlan,
	codeboxDocsAgentRecipeRequest,
} = require('../lib/codebox-docs-agent-recipe-planner');

const contract = JSON.parse(fs.readFileSync(path.join(
	__dirname,
	'..',
	'..',
	'agent-runtimes',
	'fixtures',
	'homeboy-agent-task-core-contract.json'
), 'utf8'));

const plan = codeboxDocsAgentRecipePlan({
	planId: 'docs-agent-recipe-plan-smoke',
	recipePack: 'public-codebox-docs-agent-recipes',
	recipeName: 'docs-agent-update',
	recipeRef: 'main',
	recipeInputs: {
		docsRoot: 'docs',
		prompt: 'Refresh public API documentation.',
	},
	targetRepo: 'Automattic/docs-agent',
	targetRef: 'refs/pull/123/head',
	concurrency: 1,
	timeoutSeconds: 900,
	expectedArtifacts: ['docs-agent-summary'],
	secretEnv: ['DOCS_AGENT_GITHUB_TOKEN'],
});

assert.equal(plan.schema, contract.schemas.plan);
assert.equal(plan.plan_id, 'docs-agent-recipe-plan-smoke');
assert.equal(plan.tasks.length, 1);
assert.equal(plan.metadata.planner, 'homeboy-extension-wordpress/codebox-docs-agent-recipe-planner');

const task = plan.tasks[0];
assert.equal(task.schema, contract.schemas.request);
assert.equal(task.task_id, 'docs-agent-recipe-plan-smoke-task');
assert.equal(task.executor.backend, 'codebox');
assert.equal(task.executor.runtime, 'wp-codebox');
assert.deepEqual(task.executor.secret_env, ['DOCS_AGENT_GITHUB_TOKEN']);
assert.deepEqual(task.expected_artifacts, ['docs-agent-summary']);
assert.equal(task.limits.task_timeout_seconds, 900);
assert.equal(task.inputs.recipe.pack, 'public-codebox-docs-agent-recipes');
assert.equal(task.inputs.recipe.name, 'docs-agent-update');
assert.equal(task.inputs.recipe.target_repo, 'Automattic/docs-agent');
assert.equal(task.inputs.recipe.target_ref, 'refs/pull/123/head');
assert.deepEqual(task.inputs.recipe.inputs, {
	docsRoot: 'docs',
	prompt: 'Refresh public API documentation.',
});
assert.deepEqual(task.policy, { read: 'sandbox', write: 'sandbox', apply: 'review' });

const publicInput = JSON.stringify({
	recipePack: 'public-codebox-docs-agent-recipes',
	recipeName: 'docs-agent-update',
	recipeInputs: { docsRoot: 'docs' },
});
assert(!publicInput.includes('datamachine/'), 'public Docs Agent inputs must not require Data Machine ability names');
assert(!publicInput.includes('provider_plugin'), 'public Docs Agent inputs must not require provider plugin internals');
assert(!publicInput.includes('mount'), 'public Docs Agent inputs must not require Codebox mount internals');
assert(!publicInput.includes('component'), 'public Docs Agent inputs must not require component paths');

const serializedPlan = JSON.stringify(plan);
assert(!serializedPlan.includes('datamachine/'), 'Docs Agent recipe plan must not expose Data Machine ability names');
assert(!serializedPlan.includes('provider_plugin_paths'), 'Docs Agent recipe plan must not expose provider plugin paths');
assert(!serializedPlan.includes('runtime_component_paths'), 'Docs Agent recipe plan must not expose component paths');
assert(!serializedPlan.includes('wp_codebox_mounts'), 'Docs Agent recipe plan must not expose Codebox mounts');

const request = codeboxDocsAgentRecipeRequest({
	taskId: 'docs-agent-single-request',
	recipe: {
		path: '.github/codebox/docs-agent.recipe.json',
		inputs: { docsRoot: 'guides' },
	},
});
assert.equal(request.instructions, 'Run the Docs Agent recipe .github/codebox/docs-agent.recipe.json and return the declared artifacts.');
assert.equal(request.inputs.recipe.path, '.github/codebox/docs-agent.recipe.json');

assert.throws(
	() => codeboxDocsAgentRecipePlan({ planId: 'missing-recipe' }),
	/recipe requires pack, name, path, or repository\./
);

const script = path.join(__dirname, '..', 'scripts', 'agent', 'homeboy-codebox-docs-agent-recipe-plan.cjs');
const result = spawnSync(process.execPath, [
	script,
	'--plan-id', 'cli-docs-agent-recipe-plan-smoke',
	'--recipe-pack', 'public-codebox-docs-agent-recipes',
	'--recipe-name', 'docs-agent-update',
	'--recipe-inputs', '{"docsRoot":"docs"}',
	'--target-repo', 'Automattic/docs-agent',
	'--target-ref', 'refs/pull/124/head',
	'--expected-artifact', 'docs-agent-summary',
	'--timeout-seconds', '60',
], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
const cliPlan = JSON.parse(result.stdout);
assert.equal(cliPlan.schema, contract.schemas.plan);
assert.equal(cliPlan.tasks[0].inputs.recipe.name, 'docs-agent-update');
assert.equal(cliPlan.tasks[0].inputs.recipe.target_repo, 'Automattic/docs-agent');
assert.equal(cliPlan.tasks[0].limits.task_timeout_seconds, 60);
assert(!JSON.stringify(cliPlan).includes('datamachine/'));

process.stdout.write('Codebox Docs Agent recipe planner smoke passed\n');
