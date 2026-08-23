'use strict';

const {
	providerContract,
} = require('./opencode-agent-task-executor');
const {
	externalStorageRetentionProviderContract,
} = require('./opencode-external-storage-retention');

function runtimeManifest() {
	return {
		schema: 'homeboy/agent-runtime-manifest/v1',
		id: 'opencode',
		name: 'OpenCode',
		version: '1.4.1',
		description: 'OpenCode agent runtime for nested orchestration and repository-scoped agent tasks.',
		requires: {
			homeboy: '>=0.355.5',
		},
		compatibility: {
			immediate_failure_patterns: {
				owner: 'Extra-Chill/homeboy#12293',
				requirement: 'Homeboy core support for agent-task executor immediate_failure_patterns.',
			},
		},
		contract_producers: [
			{
				id: 'opencode.agent-task-result',
				phase: 'result',
				invocation: {
					script: 'scripts/agent/homeboy-opencode-agent-task-executor.cjs',
					input_schema: 'homeboy/agent-task-request/v1',
					output_schema: 'homeboy/agent-task-outcome/v1',
				},
				produces: [
					{
						kind: 'status',
						name: 'agent-task-outcome',
						schema: 'homeboy/agent-task-outcome/v1',
					},
				],
			},
		],
		external_storage_retention: {
			providers: [externalStorageRetentionProviderContract()],
		},
		agent_task_executors: [providerContract()],
	};
}

module.exports = {
	runtimeManifest,
};
