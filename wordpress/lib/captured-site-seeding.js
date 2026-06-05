'use strict';

/**
 * External dependencies
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Internal dependencies
 */
const { isPlainObject } = require('./shared');

const DEFAULT_LIMITS = Object.freeze({
	maxPosts: 25,
	maxOptions: 25,
	maxPluginState: 25,
	maxStringBytes: 16 * 1024,
});

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|credential|cookie|authorization|private[_-]?key|access[_-]?key|client[_-]?secret)/i;
const LOCAL_PATH_PATTERN = /(^|[\s"'])((?:file:\/\/)?\/(?:Users|home|var\/www|srv|private|tmp)\/[^\s"']*)/i;
const PRIVATE_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[^\s/]+\.(?:local|test|internal|lan))(?:[/:?#]|$)/i;

function readCapturedSiteManifest(manifestPath) {
	if (typeof manifestPath !== 'string' || manifestPath.trim() === '') {
		throw new TypeError('captured-site manifest path must be a non-empty string');
	}
	const resolved = path.resolve(manifestPath);
	if (!fs.existsSync(resolved)) {
		throw new Error(`captured-site manifest not found: ${resolved}`);
	}
	return {
		path: resolved,
		manifest: JSON.parse(fs.readFileSync(resolved, 'utf8')),
	};
}

function normalizeCapturedSiteManifest(manifest, options = {}) {
	if (!isPlainObject(manifest)) {
		throw new TypeError('captured-site manifest must be an object');
	}
	const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
	const summary = {
		schema: 'homeboy/wordpress-captured-site-seed/v1',
		role: options.role || manifest.role || 'site',
		seeded: [],
		skipped: [],
		blocked: [],
		unavailable: [],
	};

	const posts = normalizePosts(readArray(manifest, ['posts', 'content.posts', 'resources.posts']), limits, summary);
	const optionsList = normalizeOptions(readOptions(manifest), limits, summary);
	const pluginState = normalizePluginState(readArray(manifest, ['plugin_state', 'pluginState', 'resources.plugin_state', 'plugins']), limits, summary);

	return {
		schema: 'homeboy/wordpress-captured-site-seed/v1',
		role: summary.role,
		posts,
		options: optionsList,
		pluginState,
		summary,
	};
}

function buildCapturedSiteSeedWorkloadStep(seed, options = {}) {
	if (!isPlainObject(seed) || seed.schema !== 'homeboy/wordpress-captured-site-seed/v1') {
		throw new TypeError('captured-site seed must be normalized with normalizeCapturedSiteManifest()');
	}
	return {
		type: 'php',
		label: options.label || `Seed ${seed.role} captured site`,
		code: buildSeedPhp(seed, options),
	};
}

function buildCapturedSiteSeedRecipeSteps(seed) {
	return [buildCapturedSiteSeedWorkloadStep(seed)];
}

function normalizePosts(posts, limits, summary) {
	return posts.slice(0, limits.maxPosts).map((post, index) => {
		if (!isPlainObject(post)) {
			summary.skipped.push({ kind: 'post', index, reason: 'entry is not an object' });
			return null;
		}
		const candidate = {
			post_type: safeScalar(post.post_type || post.type || 'post', `posts[${index}].post_type`, summary, limits),
			post_title: safeScalar(post.post_title || post.title || `Captured post ${index + 1}`, `posts[${index}].post_title`, summary, limits),
			post_name: safeScalar(post.post_name || post.slug || '', `posts[${index}].post_name`, summary, limits),
			post_status: safeScalar(post.post_status || post.status || 'publish', `posts[${index}].post_status`, summary, limits),
			post_content: safeScalar(post.post_content || post.content || '', `posts[${index}].post_content`, summary, limits),
		};
		if (Object.values(candidate).some((value) => value === null)) {
			summary.blocked.push({ kind: 'post', index, reason: 'contains private or oversized data' });
			return null;
		}
		summary.seeded.push({ kind: 'post', index, post_type: candidate.post_type, post_name: candidate.post_name });
		return candidate;
	}).filter(Boolean);
}

function normalizeOptions(options, limits, summary) {
	return options.slice(0, limits.maxOptions).map((entry, index) => {
		const name = safeScalar(entry.name, `options[${index}].name`, summary, limits);
		if (name && SECRET_KEY_PATTERN.test(name)) {
			summary.blocked.push({ kind: 'option', index, name, reason: 'sensitive key rejected' });
			return null;
		}
		const value = safeValue(entry.value, `options[${index}].value`, summary, limits);
		if (!name || value === null) {
			summary.blocked.push({ kind: 'option', index, name: name || '', reason: 'contains private or oversized data' });
			return null;
		}
		summary.seeded.push({ kind: 'option', index, name });
		return { name, value };
	}).filter(Boolean);
}

function normalizePluginState(entries, limits, summary) {
	return entries.slice(0, limits.maxPluginState).map((entry, index) => {
		if (!isPlainObject(entry)) {
			summary.skipped.push({ kind: 'plugin_state', index, reason: 'entry is not an object' });
			return null;
		}
		const plugin = safeScalar(entry.plugin || entry.slug || entry.name || `plugin-${index + 1}`, `plugin_state[${index}].plugin`, summary, limits);
		const state = safeValue(entry.state || entry.data || entry.options || {}, `plugin_state[${index}].state`, summary, limits);
		if (!plugin || state === null) {
			summary.blocked.push({ kind: 'plugin_state', index, plugin: plugin || '', reason: 'contains private or oversized data' });
			return null;
		}
		summary.seeded.push({ kind: 'plugin_state', index, plugin });
		return { plugin, state };
	}).filter(Boolean);
}

function readOptions(manifest) {
	const value = readPath(manifest, 'options') || readPath(manifest, 'resources.options') || [];
	if (Array.isArray(value)) {
		return value.map((entry) => isPlainObject(entry) ? entry : { name: '', value: entry });
	}
	if (isPlainObject(value)) {
		return Object.entries(value).map(([name, optionValue]) => ({ name, value: optionValue }));
	}
	return [];
}

function readArray(manifest, paths) {
	for (const candidate of paths) {
		const value = readPath(manifest, candidate);
		if (Array.isArray(value)) {
			return value;
		}
		if (isPlainObject(value)) {
			return Object.entries(value).map(([name, state]) => ({ name, state }));
		}
	}
	return [];
}

function readPath(object, dottedPath) {
	return dottedPath.split('.').reduce((value, key) => isPlainObject(value) ? value[key] : undefined, object);
}

function safeScalar(value, location, summary, limits) {
	const text = String(value ?? '');
	return safeValue(text, location, summary, limits);
}

function safeValue(value, location, summary, limits) {
	if (value === undefined) {
		return '';
	}
	if (value === null || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		if (Buffer.byteLength(value, 'utf8') > limits.maxStringBytes) {
			summary.unavailable.push({ location, reason: 'string exceeds bounded seed size' });
			return null;
		}
		if (LOCAL_PATH_PATTERN.test(value) || PRIVATE_URL_PATTERN.test(value)) {
			summary.blocked.push({ location, reason: 'contains local path or private URL' });
			return null;
		}
		return value;
	}
	if (Array.isArray(value)) {
		const next = [];
		for (let index = 0; index < value.length; index += 1) {
			const child = safeValue(value[index], `${location}[${index}]`, summary, limits);
			if (child === null) {
				return null;
			}
			next.push(child);
		}
		return next;
	}
	if (isPlainObject(value)) {
		const next = {};
		for (const [key, childValue] of Object.entries(value)) {
			if (SECRET_KEY_PATTERN.test(key)) {
				summary.blocked.push({ location: `${location}.${key}`, reason: 'sensitive key rejected' });
				return null;
			}
			const child = safeValue(childValue, `${location}.${key}`, summary, limits);
			if (child === null) {
				return null;
			}
			next[key] = child;
		}
		return next;
	}
	summary.skipped.push({ location, reason: `unsupported value type ${typeof value}` });
	return null;
}

function buildSeedPhp(seed, options = {}) {
	const summaryOption = options.summaryOption || `homeboy_captured_site_seed_${seed.role}`;
	const payload = JSON.stringify(seed);
	return `
$seed = json_decode('${phpSingleQuoted(payload)}', true);
$summary = $seed['summary'];
foreach ($seed['posts'] as $post) {
    wp_insert_post($post, true);
}
foreach ($seed['options'] as $option) {
    update_option($option['name'], $option['value'], false);
}
foreach ($seed['pluginState'] as $state) {
    update_option('homeboy_seed_' . sanitize_key($seed['role']) . '_' . sanitize_key($state['plugin']), $state['state'], false);
}
update_option('${phpSingleQuoted(summaryOption)}', $summary, false);
return array(
    'metrics' => array(
        'seeded_posts' => count($seed['posts']),
        'seeded_options' => count($seed['options']),
        'seeded_plugin_state' => count($seed['pluginState']),
        'blocked_seed_items' => count($summary['blocked']),
        'skipped_seed_items' => count($summary['skipped']),
    ),
    'metadata' => array(
        'captured_site_seed' => $summary,
    ),
);
`;
}

function phpSingleQuoted(value) {
	return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

module.exports = {
	buildCapturedSiteSeedRecipeSteps,
	buildCapturedSiteSeedWorkloadStep,
	normalizeCapturedSiteManifest,
	readCapturedSiteManifest,
};
