'use strict';

const OPENCODE_AUTH_PLANS = {
	openai: {
		provider: 'openai',
		account_kind: 'openai_api_key',
		auth_kind: 'api_key',
		secret_env: ['OPENAI_API_KEY'],
		secret_env_sources: {
			OPENAI_API_KEY: { source: 'environment', env: 'OPENAI_API_KEY' },
		},
	},
	codex: {
		provider: 'codex',
		account_kind: 'openai_codex_oauth',
		auth_kind: 'oauth',
		secret_env: [
			'AI_PROVIDER_OPENAI_CODEX_ACCESS_TOKEN',
			'AI_PROVIDER_OPENAI_CODEX_REFRESH_TOKEN',
			'AI_PROVIDER_OPENAI_CODEX_EXPIRES_AT',
			'AI_PROVIDER_OPENAI_CODEX_ACCOUNT_ID',
			'AI_PROVIDER_OPENAI_CODEX_FEDRAMP',
		],
	},
};

function resolveOpenCodeAuthPlan(config = {}) {
	const route = selectedOpenCodeRoute(config);
	const plan = OPENCODE_AUTH_PLANS[route.provider];
	if (!plan) {
		return {
			supported: false,
			provider: route.provider,
			model: route.model,
			reason: `No declared OpenCode credential route exists for provider ${route.provider || '(missing)'}.`,
		};
	}
	return { supported: true, model: route.model, ...clonePlan(plan) };
}

function selectedOpenCodeRoute(config = {}) {
	const configuredModel = typeof config.model === 'string' ? config.model.trim() : '';
	const separator = configuredModel.indexOf('/');
	return {
		provider: separator > 0 ? configuredModel.slice(0, separator) : (typeof config.provider === 'string' ? config.provider.trim() : ''),
		model: separator > 0 ? configuredModel.slice(separator + 1) : configuredModel,
	};
}

function clonePlan(plan) {
	return {
		...plan,
		secret_env: [...plan.secret_env],
		secret_env_sources: Object.fromEntries(Object.entries(plan.secret_env_sources || {}).map(([name, source]) => [name, { ...source }])),
	};
}

module.exports = { OPENCODE_AUTH_PLANS, resolveOpenCodeAuthPlan, selectedOpenCodeRoute };
