'use strict';

/**
 * Internal dependencies
 */
const {
	GENERIC_AGENT_TASK_PLAN_SCHEMA,
	GENERIC_AGENT_TASK_REQUEST_SCHEMA,
	genericAgentTaskPlan,
	genericAgentTaskRequest,
	genericAgentTaskRunnerSpec,
} = require('./generic-agent-task-plan');

const CODEBOX_DOCS_AGENT_RECIPE_PLAN_SCHEMA = GENERIC_AGENT_TASK_PLAN_SCHEMA;
const CODEBOX_DOCS_AGENT_RECIPE_REQUEST_SCHEMA = GENERIC_AGENT_TASK_REQUEST_SCHEMA;
const CODEBOX_DOCS_AGENT_INTERNAL_BACKEND = 'codebox';
const CODEBOX_DOCS_AGENT_INTERNAL_RUNTIME = 'wp-codebox';
const CODEBOX_DOCS_AGENT_DEFAULT_POLICY = {
	read: 'sandbox',
	write: 'sandbox',
	apply: 'review',
};

function codeboxDocsAgentRecipePlan(options = {}) {
	const planId = requiredString(options.planId || options.plan_id, 'planId');
	const taskOptions = normalizeTaskOptions(options);
	const tasks = taskOptions.map((taskOption, index) => codeboxDocsAgentRecipeRequest({
		...options,
		...taskOption,
		planId,
		parentPlanId: planId,
		taskId: taskOption.taskId || taskOption.task_id || taskIdForPlan(planId, index),
	}));

	return genericAgentTaskPlan({
		schema: CODEBOX_DOCS_AGENT_RECIPE_PLAN_SCHEMA,
		plan_id: planId,
		tasks,
		options: stripUndefined({
			concurrency: numberOrUndefined(options.concurrency),
			fail_fast: options.failFast ?? options.fail_fast,
		}),
		metadata: stripUndefined({
			...(options.metadata || {}),
			planner: 'homeboy-extension-wordpress/codebox-docs-agent-recipe-planner',
			workflow: 'codebox-docs-agent-recipe',
		}),
	});
}

function codeboxDocsAgentRecipeRequest(options = {}) {
	const taskId = requiredString(options.taskId || options.task_id, 'taskId');
	const recipe = normalizeRecipe(options);
	const runnerSpec = codeboxDocsAgentRecipeRunnerSpec({
		...options,
		recipe,
	});

	return genericAgentTaskRequest({
		schema: CODEBOX_DOCS_AGENT_RECIPE_REQUEST_SCHEMA,
		task_id: taskId,
		group_key: options.groupKey || options.group_key,
		parent_plan_id: options.parentPlanId || options.parent_plan_id || options.planId || options.plan_id,
		repo: options.repo,
		workspace: options.workspace,
		instructions: options.instructions || instructionsForRecipe(recipe),
		inputs: stripUndefined({
			...(options.inputs || {}),
			recipe,
		}),
		source_refs: normalizeArray(options.sourceRefs || options.source_refs),
		policy: options.policy || CODEBOX_DOCS_AGENT_DEFAULT_POLICY,
		metadata: stripUndefined({
			...(options.metadata || {}),
			recipe: recipeMetadata(recipe),
		}),
		includeArtifactDeclarations: options.includeArtifactDeclarations === false
			? false
			: normalizeArray(options.artifactDeclarations || options.artifact_declarations).length > 0,
		runnerSpec,
	});
}

function codeboxDocsAgentRecipeRunnerSpec(options = {}) {
	return genericAgentTaskRunnerSpec({
		backend: CODEBOX_DOCS_AGENT_INTERNAL_BACKEND,
		runtime: CODEBOX_DOCS_AGENT_INTERNAL_RUNTIME,
		config: stripUndefined({
			...(options.config || {}),
			recipe: options.recipe || normalizeRecipe(options),
		}),
		secret_env: normalizeArray(options.secretEnv || options.secret_env),
		task_timeout_seconds: numberOrUndefined(options.taskTimeoutSeconds || options.task_timeout_seconds || options.timeoutSeconds || options.timeout_seconds),
		limits: options.limits,
		artifact_declarations: options.artifactDeclarations || options.artifact_declarations,
		expected_artifacts: options.expectedArtifacts || options.expected_artifacts,
	});
}

function normalizeRecipe(options = {}) {
	const explicit = objectOrEmpty(options.recipe);
	const recipe = stripUndefined({
		pack: explicit.pack || explicit.package || options.recipePack || options.recipe_pack,
		name: explicit.name || options.recipeName || options.recipe_name,
		ref: explicit.ref || options.recipeRef || options.recipe_ref,
		path: explicit.path || options.recipePath || options.recipe_path,
		repository: explicit.repository || explicit.repo || options.recipeRepository || options.recipe_repository || options.recipeRepo || options.recipe_repo,
		target_ref: explicit.target_ref || explicit.targetRef || options.targetRef || options.target_ref,
		target_repo: explicit.target_repo || explicit.targetRepo || options.targetRepo || options.target_repo,
		target_pr: explicit.target_pr || explicit.targetPr || options.targetPr || options.target_pr,
		target_branch: explicit.target_branch || explicit.targetBranch || options.targetBranch || options.target_branch,
		inputs: objectOrUndefined(explicit.inputs || options.recipeInputs || options.recipe_inputs),
		secret_env: nonEmptyArray(explicit.secret_env || explicit.secretEnv || options.recipeSecretEnv || options.recipe_secret_env),
		metadata: objectOrUndefined(explicit.metadata),
	});
	if (!recipe.pack && !recipe.name && !recipe.path && !recipe.repository) {
		throw new Error('recipe requires pack, name, path, or repository.');
	}
	return recipe;
}

function recipeMetadata(recipe = {}) {
	return stripUndefined({
		pack: recipe.pack,
		name: recipe.name,
		ref: recipe.ref,
		path: recipe.path,
		repository: recipe.repository,
		target_ref: recipe.target_ref,
		target_repo: recipe.target_repo,
		target_pr: recipe.target_pr,
		target_branch: recipe.target_branch,
	});
}

function normalizeTaskOptions(options = {}) {
	const tasks = normalizeArray(options.tasks);
	return tasks.length > 0 ? tasks : [{}];
}

function taskIdForPlan(planId, index) {
	return index === 0 ? `${planId}-task` : `${planId}-${index + 1}`;
}

function instructionsForRecipe(recipe = {}) {
	const label = [recipe.pack, recipe.name].filter(Boolean).join('/') || recipe.path || recipe.repository || 'the selected recipe';
	return `Run the Docs Agent recipe ${label} and return the declared artifacts.`;
}

function normalizeArray(value) {
	return Array.isArray(value) ? value.filter(Boolean) : [];
}

function nonEmptyArray(value) {
	const normalized = normalizeArray(value);
	return normalized.length > 0 ? normalized : undefined;
}

function objectOrEmpty(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function objectOrUndefined(value) {
	return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 ? value : undefined;
}

function requiredString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${name} is required.`);
	}
	return value;
}

function numberOrUndefined(value) {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function stripUndefined(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return value;
	}
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

module.exports = {
	CODEBOX_DOCS_AGENT_RECIPE_PLAN_SCHEMA,
	CODEBOX_DOCS_AGENT_RECIPE_REQUEST_SCHEMA,
	CODEBOX_DOCS_AGENT_DEFAULT_POLICY,
	codeboxDocsAgentRecipePlan,
	codeboxDocsAgentRecipeRequest,
	codeboxDocsAgentRecipeRunnerSpec,
};
