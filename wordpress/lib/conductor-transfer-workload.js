'use strict';

/**
 * External dependencies
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Internal dependencies
 */
const {
	buildCapturedSiteSeedWorkloadStep,
	normalizeCapturedSiteManifest,
	readCapturedSiteManifest,
} = require('./captured-site-seeding');
const { isPlainObject } = require('./shared');

function compileConductorTransferRigs(options = {}) {
	const componentPath = path.resolve(requiredString(options.componentPath, 'componentPath'));
	const entries = normalizeEntries(options.rigs || options.specs || []);
	const workloads = [];
	const diagnostics = [];

	for (const [index, entry] of entries.entries()) {
		const { spec, specPath } = loadRigSpec(entry, componentPath, index);
		workloads.push(buildConductorTransferWorkload(spec, {
			componentPath,
			specPath,
			artifactDir: options.artifactDir,
			index,
			diagnostics,
		}));
	}

	return {
		schema: 'homeboy/wordpress-conductor-transfer-rigs/v1',
		workloads,
		diagnostics,
	};
}

function buildConductorTransferWorkload(spec, context = {}) {
	if (!isPlainObject(spec)) {
		throw new TypeError('Conductor transfer rig spec must be an object');
	}
	const id = sanitizeId(spec.id || spec.slug || spec.label || `conductor-transfer-${context.index + 1}`);
	const run = [];
	const metadata = {
		adapter: 'homeboy-wordpress-conductor-transfer-rig',
		adapter_schema: 'homeboy/wordpress-conductor-transfer-workload/v1',
		family: spec.family || 'synthetic-transfer',
		spec_path: context.specPath ? path.relative(context.componentPath, context.specPath) : '',
	};

	for (const role of ['source', 'target', 'sandbox']) {
		const manifestPath = manifestPathForRole(spec, role);
		if (!manifestPath) {
			continue;
		}
		const manifestBasePath = context.specPath ? path.dirname(context.specPath) : context.componentPath;
		const resolved = resolveUnderComponent(context.componentPath, manifestBasePath, manifestPath, `${role} captured-site manifest`);
		const { manifest } = readCapturedSiteManifest(resolved);
		const seed = normalizeCapturedSiteManifest(manifest, { role });
		run.push(buildCapturedSiteSeedWorkloadStep(seed, { label: `Seed ${role} runtime` }));
		metadata[`${role}_seed`] = seed.summary;
	}

	for (const step of normalizeRigSteps(spec)) {
		run.push(normalizeRigStep(step));
	}

	if (run.length === 0) {
		run.push({
			type: 'php',
			label: 'Synthetic Conductor transfer fixture',
			code: syntheticTransferPhp(id),
		});
	}

	run.push({
		type: 'php',
		role: 'grader',
		label: 'Conductor transfer workload summary',
		code: summaryPhp(id),
	});

	return {
		id,
		label: spec.label || id,
		run,
		artifacts: {
			transfer_report: {
				path: `wp-content/homeboy-conductor-transfer/${id}-report.json`,
				kind: 'json',
				label: 'Conductor transfer workload report',
			},
			...(isPlainObject(spec.artifacts) ? spec.artifacts : {}),
		},
		metadata: {
			...metadata,
			...(isPlainObject(spec.metadata) ? spec.metadata : {}),
		},
	};
}

function normalizeRigSteps(spec) {
	let explicit = [];
	if (Array.isArray(spec.run)) {
		explicit = spec.run;
	} else if (Array.isArray(spec.steps)) {
		explicit = spec.steps;
	}
	const derived = [];
	for (const [field, label] of [
		['inventory_command', 'Playground Site Sync inventory'],
		['apply_plan_command', 'Playground Site Sync apply plan'],
		['apply_command', 'Playground Site Sync apply'],
		['review_command', 'Conductor review'],
		['transfer_proof_command', 'WP Codebox transfer proof'],
	]) {
		if (typeof spec[field] === 'string' && spec[field].trim()) {
			derived.push({ type: 'wp-cli', command: spec[field], label });
		}
	}
	return [...derived, ...explicit];
}

function normalizeRigStep(step) {
	if (!isPlainObject(step)) {
		throw new TypeError('Conductor transfer rig steps must be objects');
	}
	let type = step.type;
	if (!type && step.ability) {
		type = 'ability';
	} else if (!type && step.command) {
		type = 'wp-cli';
	} else if (!type) {
		type = 'php';
	}
	if (type === 'wp-cli') {
		return copyStep(step, ['type', 'command', 'label', 'role', 'grader']);
	}
	if (type === 'ability') {
		return copyStep(step, ['type', 'ability', 'input', 'user', 'label', 'role', 'grader']);
	}
	if (type === 'php') {
		if (!step.file && !step.code) {
			throw new Error('Conductor transfer rig PHP steps require file or code');
		}
		return copyStep(step, ['type', 'file', 'code', 'label', 'role', 'grader']);
	}
	throw new Error(`Unsupported Conductor transfer rig step type: ${type}`);
}

function manifestPathForRole(spec, role) {
	const manifests = spec.captured_manifests || spec.capturedManifests || spec.manifests || {};
	return spec[`${role}_manifest`] || spec[`${role}Manifest`] || manifests[role];
}

function loadRigSpec(entry, componentPath, index) {
	if (typeof entry === 'string') {
		const specPath = resolveUnderComponent(componentPath, componentPath, entry, `Conductor transfer rig spec ${index + 1}`);
		return { specPath, spec: JSON.parse(fs.readFileSync(specPath, 'utf8')) };
	}
	if (isPlainObject(entry) && typeof entry.path === 'string') {
		const specPath = resolveUnderComponent(componentPath, componentPath, entry.path, `Conductor transfer rig spec ${index + 1}`);
		const spec = { ...JSON.parse(fs.readFileSync(specPath, 'utf8')), ...(isPlainObject(entry.overrides) ? entry.overrides : {}) };
		return { specPath, spec };
	}
	if (isPlainObject(entry)) {
		return { specPath: '', spec: entry };
	}
	throw new TypeError(`Conductor transfer rig entry ${index + 1} must be a path string or object`);
}

function resolveUnderComponent(componentPath, basePath, ref, label) {
	if (typeof ref !== 'string' || ref.trim() === '') {
		throw new TypeError(`${label} must be a non-empty path string`);
	}
	const resolved = path.resolve(path.isAbsolute(ref) ? ref : path.join(basePath, ref));
	if (resolved !== componentPath && !resolved.startsWith(`${componentPath}${path.sep}`)) {
		throw new Error(`${label} must stay under component root: ${ref}`);
	}
	if (!fs.existsSync(resolved)) {
		throw new Error(`${label} not found: ${resolved}`);
	}
	return resolved;
}

function normalizeEntries(entries) {
	if (entries === undefined || entries === null || entries === '') {
		return [];
	}
	if (Array.isArray(entries)) {
		return entries;
	}
	return [entries];
}

function copyStep(source, keys) {
	const target = {};
	for (const key of keys) {
		if (source[key] !== undefined) {
			target[key] = source[key];
		}
	}
	return target;
}

function requiredString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value;
}

function sanitizeId(value) {
	return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'conductor-transfer';
}

function syntheticTransferPhp(id) {
	return `
update_option('homeboy_conductor_transfer_${phpSingleQuoted(id)}_synthetic_ready', 1, false);
return array(
    'metrics' => array('synthetic_transfer_ready' => 1),
    'metadata' => array('conductor_transfer_family' => 'synthetic-transfer'),
);
`;
}

function summaryPhp(id) {
	return `
$report_dir = WP_CONTENT_DIR . '/homeboy-conductor-transfer';
if (!is_dir($report_dir)) {
    wp_mkdir_p($report_dir);
}
$report = array(
    'schema' => 'homeboy/wordpress-conductor-transfer-report/v1',
    'id' => '${phpSingleQuoted(id)}',
    'generated_at' => gmdate('c'),
    'status' => 'passed',
);
file_put_contents($report_dir . '/${phpSingleQuoted(id)}-report.json', wp_json_encode($report, JSON_PRETTY_PRINT));
return array(
    'success' => true,
    'reward' => 1,
    'done' => true,
    'grade' => array(
        'score' => 1,
        'max_score' => 1,
        'checks' => array(array('id' => 'conductor_transfer_workload_completed', 'passed' => true, 'score' => 1, 'max_score' => 1)),
    ),
    'metrics' => array('conductor_transfer_completed' => 1),
    'artifacts' => array('transfer_report' => 'wp-content/homeboy-conductor-transfer/${phpSingleQuoted(id)}-report.json'),
    'metadata' => array('conductor_transfer_report' => $report),
);
`;
}

function phpSingleQuoted(value) {
	return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

module.exports = {
	buildConductorTransferWorkload,
	compileConductorTransferRigs,
};
