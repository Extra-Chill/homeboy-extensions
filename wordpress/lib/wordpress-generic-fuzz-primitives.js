'use strict';

const WORDPRESS_CRUD_OPERATION_SCHEMA = 'homeboy/wordpress-crud-operation/v1';
const WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA = 'homeboy/wordpress-crud-operation-result/v1';
const WORDPRESS_FIXTURE_PERSONA_SCHEMA = 'homeboy/wordpress-fixture-persona/v1';
const WORDPRESS_PERFORMANCE_OBSERVATION_SCHEMA = 'homeboy/wordpress-performance-observation/v1';

const CRUD_ACTIONS = new Set(['create', 'read', 'update', 'delete']);
const SAFETY_LEVELS = new Set(['safe', 'mutating', 'destructive']);
const RESET_STRATEGIES = new Set(['none', 'delete-created', 'restore-snapshot', 'transaction', 'manual']);
const CRUD_RESULT_STATUSES = new Set(['passed', 'failed', 'errored', 'skipped']);
const ROLLBACK_RESULT_STATUSES = new Set(['not-required', 'passed', 'failed', 'errored', 'skipped']);
const OBSERVATION_STATUSES = new Set(['passed', 'failed', 'errored', 'skipped']);

function normalizeWordPressCrudOperation(operation) {
	assertPlainObject(operation, 'operation');
	assertSchema(operation.schema, WORDPRESS_CRUD_OPERATION_SCHEMA, 'WordPress CRUD operation');

	const action = operation.action || operation.verb;
	if (!CRUD_ACTIONS.has(action)) {
		throw new Error(`Unsupported WordPress CRUD action: ${action}`);
	}

	const resourceType = operation.resource_type || operation.resourceType || operation.resource || operation.object_type || operation.objectType;
	if (!resourceType || typeof resourceType !== 'string') {
		throw new Error('operation.resource_type must be a string.');
	}

	const id = normalizeId(operation.id, `${action}-${resourceType}`, 'operation.id');

	return stripUndefined({
		schema: WORDPRESS_CRUD_OPERATION_SCHEMA,
		id,
		action,
		resource_type: resourceType,
		label: operation.label || id,
		safety: normalizeSafety(operation.safety, action),
		capability_context: normalizeCapabilityContext(operation.capability_context || operation.capabilityContext),
		nonce_context: normalizeNonceContext(operation.nonce_context || operation.nonceContext),
		transport: normalizeTransport(operation.transport),
		input: objectOrUndefined(operation.input),
		expected: objectOrUndefined(operation.expected),
		rollback_policy: normalizeResetPolicy(operation.rollback_policy || operation.rollbackPolicy || operation.reset_policy || operation.resetPolicy, action),
		metadata: objectOrUndefined(operation.metadata) || {},
	});
}

function normalizeWordPressCrudOperationResult(result) {
	assertPlainObject(result, 'result');
	assertSchema(result.schema, WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA, 'WordPress CRUD operation result');

	const operation = result.operation ? normalizeWordPressCrudOperation(result.operation) : undefined;
	const action = result.action || result.operation_action || result.operationAction || operation?.action;
	if (action !== undefined && !CRUD_ACTIONS.has(action)) {
		throw new Error(`Unsupported WordPress CRUD result action: ${action}`);
	}
	const resourceType = result.resource_type || result.resourceType || operation?.resource_type;
	if (!resourceType || typeof resourceType !== 'string') {
		throw new Error('result.resource_type must be a string.');
	}

	const failures = asArray(result.failures || result.errors, 'result.failures');
	const status = result.status || defaultCrudResultStatus(result, failures);
	if (!CRUD_RESULT_STATUSES.has(status)) {
		throw new Error(`Unsupported WordPress CRUD result status: ${status}`);
	}

	return stripUndefined({
		schema: WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA,
		id: normalizeId(result.id, `${result.operation_id || result.operationId || operation?.id || resourceType}-result`, 'result.id'),
		operation_id: result.operation_id || result.operationId || operation?.id || null,
		operation,
		action,
		resource_type: resourceType,
		resource_id: result.resource_id ?? result.resourceId ?? result.object_id ?? result.objectId ?? null,
		auth_context: normalizeAuthContext(result.auth_context || result.authContext || result.auth || result.user),
		persona_id: stringOrUndefined(result.persona_id || result.personaId),
		capability_context: normalizeCapabilityContext(result.capability_context || result.capabilityContext || operation?.capability_context),
		nonce_context: normalizeNonceContext(result.nonce_context || result.nonceContext || operation?.nonce_context),
		before_state_hash: stringOrUndefined(result.before_state_hash || result.beforeStateHash || result.before_hash || result.beforeHash),
		after_state_hash: stringOrUndefined(result.after_state_hash || result.afterStateHash || result.after_hash || result.afterHash),
		rollback_policy: normalizeResetPolicy(result.rollback_policy || result.rollbackPolicy || operation?.rollback_policy, action || 'read'),
		rollback_result: normalizeRollbackResult(result.rollback_result || result.rollbackResult),
		created_refs: normalizeCreatedRefs(result.created_refs || result.createdRefs || result.created),
		status,
		skip_reason: result.skip_reason || result.skipReason || null,
		skip_reasons: normalizeReasonCodes(result.skip_reasons || result.skipReasons || result.skip_reason || result.skipReason),
		failures,
		artifacts: asArray(result.artifacts, 'result.artifacts'),
		metadata: objectOrUndefined(result.metadata) || {},
	});
}

function normalizeWordPressFixturePersona(persona) {
	assertPlainObject(persona, 'persona');
	assertSchema(persona.schema, WORDPRESS_FIXTURE_PERSONA_SCHEMA, 'WordPress fixture persona');

	const id = normalizeId(persona.id, null, 'persona.id');
	const fixtures = asArray(persona.fixtures, 'fixtures').map(normalizeFixture);

	return stripUndefined({
		schema: WORDPRESS_FIXTURE_PERSONA_SCHEMA,
		id,
		label: persona.label || id,
		description: stringOrUndefined(persona.description),
		auth_context: normalizeAuthContext(persona.auth_context || persona.authContext || persona.user),
		fixtures,
		reset_policy: normalizeResetPolicy(persona.reset_policy || persona.resetPolicy, 'update'),
		metadata: objectOrUndefined(persona.metadata) || {},
	});
}

function normalizeWordPressPerformanceObservation(observation) {
	assertPlainObject(observation, 'observation');
	assertSchema(observation.schema, WORDPRESS_PERFORMANCE_OBSERVATION_SCHEMA, 'WordPress performance observation');

	const id = normalizeId(observation.id, 'wordpress-performance-observation', 'observation.id');
	const samples = asArray(observation.samples, 'samples').map(normalizePerformanceSample);
	const durationMs = numberOrNull(observation.duration_ms ?? observation.durationMs) ?? sumSampleDurations(samples);
	const status = observation.status || 'passed';
	if (!OBSERVATION_STATUSES.has(status)) {
		throw new Error(`Unsupported WordPress performance observation status: ${status}`);
	}

	return stripUndefined({
		schema: WORDPRESS_PERFORMANCE_OBSERVATION_SCHEMA,
		id,
		status,
		operation_id: observation.operation_id || observation.operationId || null,
		fixture_id: observation.fixture_id || observation.fixtureId || null,
		persona_id: observation.persona_id || observation.personaId || null,
		started_at: observation.started_at || observation.startedAt || null,
		finished_at: observation.finished_at || observation.finishedAt || null,
		duration_ms: durationMs,
		summary: {
			sample_count: samples.length,
			duration_ms: durationMs,
			...(observation.summary || {}),
		},
		metrics: objectOrUndefined(observation.metrics) || {},
		budgets: objectOrUndefined(observation.budgets),
		regressions: asArray(observation.regressions, 'regressions'),
		samples,
		runtime: objectOrUndefined(observation.runtime),
		metadata: objectOrUndefined(observation.metadata) || {},
	});
}

function normalizeFixture(fixture, index) {
	assertPlainObject(fixture, `fixtures[${index}]`);
	const id = normalizeId(fixture.id, `fixture-${index + 1}`, `fixtures[${index}].id`);
	const type = fixture.type || fixture.resource_type || fixture.resourceType;
	if (!type || typeof type !== 'string') {
		throw new Error(`fixtures[${index}].type must be a string.`);
	}

	return stripUndefined({
		...fixture,
		id,
		type,
		operation: fixture.operation ? normalizeWordPressCrudOperation(fixture.operation) : undefined,
		depends_on: asArray(fixture.depends_on || fixture.dependsOn, `fixtures[${index}].depends_on`),
		reset_policy: normalizeResetPolicy(fixture.reset_policy || fixture.resetPolicy, 'create'),
		metadata: objectOrUndefined(fixture.metadata) || {},
	});
}

function normalizeSafety(safety, action) {
	const defaults = defaultSafetyForAction(action);
	if (safety === undefined || safety === null) {
		return defaults;
	}
	assertPlainObject(safety, 'safety');
	const level = safety.level || defaults.level;
	if (!SAFETY_LEVELS.has(level)) {
		throw new Error(`Unsupported WordPress operation safety level: ${level}`);
	}

	return {
		level,
		mutates: safety.mutates ?? defaults.mutates,
		rollback_required: safety.rollback_required ?? safety.rollbackRequired ?? defaults.rollback_required,
		reason_codes: normalizeReasonCodes(safety.reason_codes || safety.reasonCodes || defaults.reason_codes),
	};
}

function defaultSafetyForAction(action) {
	if (action === 'read') {
		return { level: 'safe', mutates: false, rollback_required: false, reason_codes: [] };
	}
	if (action === 'delete') {
		return { level: 'destructive', mutates: true, rollback_required: true, reason_codes: ['delete_operation'] };
	}
	return { level: 'mutating', mutates: true, rollback_required: true, reason_codes: [`${action}_operation`] };
}

function normalizeCapabilityContext(context) {
	if (context === undefined || context === null) {
		return undefined;
	}
	assertPlainObject(context, 'capability_context');
	return stripUndefined({
		required: normalizeStringArray(context.required || context.capabilities, 'capability_context.required'),
		forbidden: normalizeStringArray(context.forbidden, 'capability_context.forbidden'),
		role: stringOrUndefined(context.role),
		user_id: context.user_id ?? context.userId,
		metadata: objectOrUndefined(context.metadata),
	});
}

function normalizeNonceContext(context) {
	if (context === undefined || context === null) {
		return undefined;
	}
	assertPlainObject(context, 'nonce_context');
	return stripUndefined({
		action: stringOrUndefined(context.action),
		field: stringOrUndefined(context.field),
		source: stringOrUndefined(context.source),
		required: context.required,
		metadata: objectOrUndefined(context.metadata),
	});
}

function normalizeAuthContext(context) {
	if (context === undefined || context === null) {
		return undefined;
	}
	assertPlainObject(context, 'auth_context');
	return stripUndefined({
		user_id: context.user_id ?? context.userId,
		username: stringOrUndefined(context.username || context.user_login),
		roles: normalizeStringArray(context.roles, 'auth_context.roles'),
		capabilities: normalizeStringArray(context.capabilities, 'auth_context.capabilities'),
		nonce_context: normalizeNonceContext(context.nonce_context || context.nonceContext),
		metadata: objectOrUndefined(context.metadata),
	});
}

function normalizeTransport(transport) {
	if (transport === undefined || transport === null) {
		return undefined;
	}
	assertPlainObject(transport, 'transport');
	return stripUndefined({
		type: stringOrUndefined(transport.type),
		method: stringOrUndefined(transport.method),
		route: stringOrUndefined(transport.route),
		path: stringOrUndefined(transport.path),
		command: stringOrUndefined(transport.command),
		metadata: objectOrUndefined(transport.metadata),
	});
}

function normalizeResetPolicy(policy, action) {
	const defaults = defaultResetPolicyForAction(action);
	if (policy === undefined || policy === null) {
		return defaults;
	}
	assertPlainObject(policy, 'reset_policy');
	const strategy = policy.strategy || defaults.strategy;
	if (!RESET_STRATEGIES.has(strategy)) {
		throw new Error(`Unsupported WordPress reset policy strategy: ${strategy}`);
	}
	return stripUndefined({
		strategy,
		scope: stringOrUndefined(policy.scope || defaults.scope),
		after_each_case: policy.after_each_case ?? policy.afterEachCase ?? defaults.after_each_case,
		artifacts: normalizeStringArray(policy.artifacts, 'reset_policy.artifacts'),
		metadata: objectOrUndefined(policy.metadata),
	});
}

function normalizeRollbackResult(result) {
	if (result === undefined || result === null) {
		return undefined;
	}
	assertPlainObject(result, 'rollback_result');
	const status = result.status || 'not-required';
	if (!ROLLBACK_RESULT_STATUSES.has(status)) {
		throw new Error(`Unsupported WordPress rollback result status: ${status}`);
	}
	return stripUndefined({
		status,
		strategy: stringOrUndefined(result.strategy),
		started_at: stringOrUndefined(result.started_at || result.startedAt),
		finished_at: stringOrUndefined(result.finished_at || result.finishedAt),
		before_state_hash: stringOrUndefined(result.before_state_hash || result.beforeStateHash || result.before_hash || result.beforeHash),
		after_state_hash: stringOrUndefined(result.after_state_hash || result.afterStateHash || result.after_hash || result.afterHash),
		failures: asArray(result.failures || result.errors, 'rollback_result.failures'),
		metadata: objectOrUndefined(result.metadata),
	});
}

function defaultCrudResultStatus(result, failures) {
	if (result.skipped || result.skip_reason || result.skipReason) {
		return 'skipped';
	}
	return failures.length > 0 ? 'failed' : 'passed';
}

function normalizeCreatedRefs(value) {
	return asArray(value, 'result.created_refs').map((entry, index) => {
		if (typeof entry === 'string' || typeof entry === 'number') {
			return { id: entry };
		}
		assertPlainObject(entry, `result.created_refs[${index}]`);
		return stripUndefined({
			resource_type: stringOrUndefined(entry.resource_type || entry.resourceType || entry.type),
			id: entry.id ?? entry.resource_id ?? entry.resourceId,
			operation_id: stringOrUndefined(entry.operation_id || entry.operationId),
			metadata: objectOrUndefined(entry.metadata),
		});
	});
}

function defaultResetPolicyForAction(action) {
	if (action === 'read') {
		return { strategy: 'none', scope: 'operation', after_each_case: false };
	}
	return { strategy: 'delete-created', scope: 'operation', after_each_case: true };
}

function normalizePerformanceSample(sample, index) {
	assertPlainObject(sample, `samples[${index}]`);
	return stripUndefined({
		id: sample.id || `sample-${index + 1}`,
		operation_id: sample.operation_id || sample.operationId,
		started_at: sample.started_at || sample.startedAt,
		finished_at: sample.finished_at || sample.finishedAt,
		duration_ms: numberOrNull(sample.duration_ms ?? sample.durationMs),
		metrics: objectOrUndefined(sample.metrics) || {},
		metadata: objectOrUndefined(sample.metadata),
	});
}

function normalizeReasonCodes(value) {
	if (value === undefined || value === null) {
		return [];
	}
	return [...new Set(asArray(Array.isArray(value) ? value : [value], 'reason_codes').map(String).filter(Boolean))].sort();
}

function normalizeStringArray(value, field) {
	return asArray(value, field).map(String).filter(Boolean);
}

function sumSampleDurations(samples) {
	const total = samples.reduce((sum, sample) => sum + (Number(sample.duration_ms) || 0), 0);
	return total > 0 ? total : null;
}

function assertPlainObject(value, field) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${field} must be an object.`);
	}
}

function assertSchema(value, expected, field) {
	if (value && value !== expected) {
		throw new Error(`Unsupported ${field} schema: ${value}`);
	}
}

function asArray(value, field) {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array.`);
	}
	return value;
}

function normalizeId(value, fallback, field) {
	const id = value || fallback;
	if (!id || typeof id !== 'string') {
		throw new Error(`${field} must be a string.`);
	}
	return id;
}

function objectOrUndefined(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function stringOrUndefined(value) {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberOrNull(value) {
	if (value === undefined || value === null || value === '') {
		return null;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function stripUndefined(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	);
}

module.exports = {
	WORDPRESS_CRUD_OPERATION_SCHEMA,
	WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA,
	WORDPRESS_FIXTURE_PERSONA_SCHEMA,
	WORDPRESS_PERFORMANCE_OBSERVATION_SCHEMA,
	normalizeWordPressCrudOperation,
	normalizeWordPressCrudOperationResult,
	normalizeWordPressFixturePersona,
	normalizeWordPressPerformanceObservation,
};
