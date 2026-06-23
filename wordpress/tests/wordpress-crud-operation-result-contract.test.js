'use strict';

const assert = require('node:assert/strict');

const {
	WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA,
	normalizeWordPressCrudOperationResult,
} = require('../lib/wordpress-generic-fuzz-primitives');
const {
	buildWordPressFuzzPlanFromSurfaces,
} = require('../lib/wordpress-fuzz-plan-from-surfaces');

const result = normalizeWordPressCrudOperationResult({
	schema: WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA,
	id: 'create-post-result',
	operation: {
		schema: 'homeboy/wordpress-crud-operation/v1',
		id: 'post:create',
		action: 'create',
		resource_type: 'post',
		capability_context: { required: ['edit_posts'] },
		nonce_context: { required: true, action: 'wp_rest' },
		rollback_policy: { strategy: 'delete-created' },
	},
	resource_id: 123,
	auth_context: { username: 'editor', roles: ['editor'], capabilities: ['edit_posts'] },
	persona_id: 'editor-persona',
	before_hash: 'sha256:before',
	after_hash: 'sha256:after',
	rollback_result: { status: 'passed', strategy: 'delete-created' },
	created_refs: [{ type: 'post', id: 123 }],
	status: 'passed',
});

assert.equal(result.schema, 'homeboy/wordpress-crud-operation-result/v1');
assert.equal(result.action, 'create');
assert.equal(result.resource_type, 'post');
assert.equal(result.resource_id, 123);
assert.deepEqual(result.auth_context.roles, ['editor']);
assert.deepEqual(result.capability_context.required, ['edit_posts']);
assert.equal(result.nonce_context.action, 'wp_rest');
assert.equal(result.before_state_hash, 'sha256:before');
assert.equal(result.after_state_hash, 'sha256:after');
assert.equal(result.rollback_policy.strategy, 'delete-created');
assert.equal(result.rollback_result.status, 'passed');
assert.deepEqual(result.created_refs, [{ resource_type: 'post', id: 123 }]);
assert.deepEqual(result.skip_reasons, []);
assert.deepEqual(result.failures, []);

assert.throws(
	() => normalizeWordPressCrudOperationResult({ schema: WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA, resource_type: 'post', status: 'unknown' }),
	/Unsupported WordPress CRUD result status/
);

const gatedPlan = buildWordPressFuzzPlanFromSurfaces({
	post_types: [{ id: 'post:post', post_type: 'post', allowCrudMutations: true }],
});
const gatedCreate = gatedPlan.targets[0].cases.find((testCase) => testCase.intent === 'create-post');
assert.equal(gatedCreate.expected_result_schema, WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA);
assert.equal(gatedCreate.metadata.expected_result_schema, WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA);
assert.equal(gatedCreate.executable, false);
assert.deepEqual(gatedCreate.required_capabilities, ['crud', 'reset', 'restore', 'snapshot']);
assert.deepEqual(gatedCreate.skip_reasons, ['missing-runtime-fuzz-capabilities']);

const capablePlan = buildWordPressFuzzPlanFromSurfaces({
	post_types: [{ id: 'post:post', post_type: 'post', allowCrudMutations: true }],
}, {
	runtimeCapabilities: { capabilities: ['crud', 'snapshot', 'restore', 'reset'] },
});
const capableCreate = capablePlan.targets[0].cases.find((testCase) => testCase.intent === 'create-post');
assert.equal(capableCreate.expected_result_schema, WORDPRESS_CRUD_OPERATION_RESULT_SCHEMA);
assert.equal(capableCreate.executable, true);
assert.deepEqual(capableCreate.skip_reasons, []);
assert.deepEqual(capableCreate.required_capabilities, ['crud', 'reset', 'restore', 'snapshot']);
assert.equal(capableCreate.metadata.runtime_capability_gated, false);

assert(!JSON.stringify(result).includes('woocommerce'), 'CRUD result contract must stay product-agnostic');

console.log('WordPress CRUD operation result contract test passed');
