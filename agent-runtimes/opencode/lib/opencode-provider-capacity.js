'use strict';

const fs = require('node:fs');
const { authStorePath, openCodeStoreSecretEnv } = require('./opencode-auth-plan');

const OPENCODE_CAPACITY_TIMEOUT_MS = 5_000;
const OPENCODE_AUTH_STORE_MAX_BYTES = 64 * 1024;

// Plan usage endpoints for providers that publish them. Each entry is a GET
// that costs no inference and maps its response into percent-used windows.
// Providers without an entry report no capacity, which Homeboy reads as
// "unknown" rather than exhausted.
const CAPACITY_PROVIDERS = {
	anthropic: {
		url: 'https://api.anthropic.com/api/oauth/usage',
		headers: (credential) => ({ Authorization: `Bearer ${credential}`, 'anthropic-beta': 'oauth-2025-04-20' }),
		windows: anthropicWindows,
	},
	openai: {
		url: 'https://chatgpt.com/backend-api/wham/usage',
		headers: (credential) => ({ Authorization: `Bearer ${credential}` }),
		windows: openAiWindows,
	},
	'zai-coding-plan': {
		url: 'https://api.z.ai/api/monitor/usage/quota/limit',
		headers: (credential) => ({ Authorization: credential }),
		windows: zaiWindows,
	},
};

const ANTHROPIC_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];
const ZAI_WINDOW_UNITS = { 3: 'hour', 4: 'day', 5: 'month', 6: 'week' };

/**
 * Look up plan capacity for one OpenCode provider.
 *
 * Resolves to null when the provider publishes no usage endpoint or has no
 * stored credential, to `{ diagnostic }` when the lookup fails, and otherwise
 * to `{ capacity, windows, exhausted }` where `capacity` matches Homeboy's
 * readiness `capacity` contract (percent of the most constrained window).
 */
async function openCodeProviderCapacity(provider, options = {}) {
	const source = CAPACITY_PROVIDERS[provider];
	if (!source) return null;
	const credential = providerCredential(provider, options.env || process.env, options.fs || fs);
	if (!credential) return null;
	const fetchImpl = options.fetch || globalThis.fetch;
	let body;
	try {
		const response = await fetchImpl(source.url, {
			method: 'GET',
			headers: { Accept: 'application/json', ...source.headers(credential) },
			signal: AbortSignal.timeout(options.timeoutMs || OPENCODE_CAPACITY_TIMEOUT_MS),
		});
		if (!response.ok) return { diagnostic: `${provider} usage lookup returned HTTP ${response.status}` };
		body = await response.json();
	} catch (error) {
		return { diagnostic: `${provider} usage lookup failed: ${error?.name === 'TimeoutError' ? 'timed out' : 'request error'}` };
	}
	let windows;
	try {
		windows = source.windows(body);
	} catch {
		windows = [];
	}
	if (!windows.length) return { diagnostic: `${provider} usage response did not include any recognized usage windows` };
	return summarizeWindows(windows);
}

function summarizeWindows(windows) {
	const [tightest] = [...windows].sort((left, right) => (
		right.used_percent - left.used_percent || resetOrder(left) - resetOrder(right)
	));
	const remaining = Math.max(0, round(100 - tightest.used_percent));
	const capacity = { remaining, limit: 100, unit: 'percent' };
	if (tightest.reset_at) capacity.reset_at = tightest.reset_at;
	return { capacity, windows, exhausted: windows.some((window) => window.exhausted) };
}

function anthropicWindows(body) {
	return ANTHROPIC_WINDOWS
		.filter((name) => finiteNumber(body?.[name]?.utilization))
		.map((name) => percentWindow(name, body[name].utilization, isoTime(body[name].resets_at)));
}

function openAiWindows(body) {
	const limit = body?.rate_limit;
	const blocked = limit?.allowed === false || limit?.limit_reached === true;
	const windows = [['primary_window', limit?.primary_window], ['secondary_window', limit?.secondary_window]]
		.filter(([, window]) => finiteNumber(window?.used_percent))
		.map(([name, window]) => percentWindow(
			windowName(window.limit_window_seconds) || name,
			window.used_percent,
			isoTime(finiteNumber(window.reset_at) ? window.reset_at * 1000 : null),
		));
	if (blocked && windows.length && !windows.some((window) => window.exhausted)) {
		// The account is blocked even though no window reads 100%: report the
		// fullest window as the exhausted one so the verdict stays truthful.
		const [fullest] = [...windows].sort((left, right) => right.used_percent - left.used_percent);
		fullest.exhausted = true;
	}
	return windows;
}

function zaiWindows(body) {
	return (Array.isArray(body?.data?.limits) ? body.data.limits : [])
		.filter((limit) => limit?.type === 'TOKENS_LIMIT' && finiteNumber(limit.percentage))
		.map((limit) => percentWindow(
			`tokens_${limit.number}_${ZAI_WINDOW_UNITS[limit.unit] || `unit${limit.unit}`}`,
			limit.percentage,
			isoTime(limit.nextResetTime),
		));
}

function percentWindow(name, usedPercent, resetAt) {
	const used = Math.min(100, Math.max(0, round(usedPercent)));
	return { name, used_percent: used, reset_at: resetAt, exhausted: used >= 100 };
}

function windowName(seconds) {
	if (!finiteNumber(seconds) || seconds <= 0) return '';
	if (seconds % 86_400 === 0) return `${seconds / 86_400}_day`;
	if (seconds % 3_600 === 0) return `${seconds / 3_600}_hour`;
	return '';
}

function providerCredential(provider, env, fileSystem) {
	const entry = authStoreEntry(provider, env, fileSystem);
	if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key) return entry.key;
	if (entry?.type === 'oauth' && typeof entry.access === 'string' && entry.access) return entry.access;
	// Lab runners materialize OAuth store secrets as AI_PROVIDER_OPENCODE_<PROVIDER>_ACCESS.
	const accessEnv = openCodeStoreSecretEnv(provider).find((name) => name.endsWith('_ACCESS'));
	return accessEnv && typeof env[accessEnv] === 'string' && env[accessEnv] ? env[accessEnv] : '';
}

function authStoreEntry(provider, env, fileSystem) {
	try {
		const file = authStorePath(env);
		const stat = fileSystem.statSync(file);
		if (!stat.isFile() || stat.size > OPENCODE_AUTH_STORE_MAX_BYTES) return null;
		const store = JSON.parse(fileSystem.readFileSync(file, 'utf8'));
		return store && typeof store === 'object' ? store[provider] || null : null;
	} catch {
		return null;
	}
}

function isoTime(value) {
	if (value === null || value === undefined || value === '') return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resetOrder(window) {
	return window.reset_at ? Date.parse(window.reset_at) : Number.POSITIVE_INFINITY;
}

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value);
}

function round(value) {
	return Math.round(value * 100) / 100;
}

module.exports = {
	OPENCODE_CAPACITY_TIMEOUT_MS,
	openCodeProviderCapacity,
};
