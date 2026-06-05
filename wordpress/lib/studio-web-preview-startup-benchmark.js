'use strict';

/**
 * External dependencies
 */
const fs = require('node:fs');

const SCHEMA = 'homeboy/studio-web-preview-startup-benchmark/v1';
const COMPARISON_SCHEMA = 'homeboy/studio-web-preview-startup-comparison/v1';
const DEFAULT_READY_TIMEOUT_MS = 180000;
const REST_ROUTE_NEEDLES = [
	'/wp-json/studio-web/v1/targets',
	'rest_route=/studio-web/v1/targets',
];
const REQUIRED_STARTUP_PHASES = [
	'playground_client_module_loaded',
	'blueprint_run_complete',
	'visible_playground_iframe_ready',
];
const METRIC_KEYS = [
	'host_page_ready_ms',
	'targets_fetch_ms',
	'preview_session_ready_ms',
	'rest_count',
	'payload_bytes',
	'blueprint_step_count',
	'playground_client_loaded_ms',
	'blueprint_complete_ms',
	'visible_iframe_ready_ms',
	'editable_preview_ready_ms',
];

function isPlainObject(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function round(value) {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function safeJsonParse(value) {
	if (typeof value !== 'string' || value.trim() === '') {
		return null;
	}
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function phaseName(phase) {
	return phase?.phase || phase?.name || phase?.kind || '';
}

function phaseElapsedMs(phase) {
	return finiteNumber(phase?.elapsed_ms) ?? finiteNumber(phase?.elapsedMs) ?? finiteNumber(phase?.time_ms) ?? finiteNumber(phase?.timeMs);
}

function normalizePhases(rawPhases) {
	return (Array.isArray(rawPhases) ? rawPhases : [])
		.filter(isPlainObject)
		.map((phase) => ({
			name: phaseName(phase),
			status: phase.status || null,
			elapsed_ms: round(phaseElapsedMs(phase)),
			since_previous_ms: round(finiteNumber(phase?.since_previous_ms) ?? finiteNumber(phase?.sincePreviousMs)),
			counter: phase.counter || phase.detail?.counter || null,
			progress_phase: phase.progressPhase || phase.progress?.phase || null,
		}))
		.filter((phase) => phase.name);
}

function firstPhase(phases, names) {
	const wanted = Array.isArray(names) ? names : [names];
	return phases.find((phase) => wanted.includes(phase.name)) || null;
}

function restLabelForUrl(url) {
	const value = String(url || '');
	if (value.includes('/preview-session')) {
		return 'prepare-preview-session';
	}
	if (REST_ROUTE_NEEDLES.some((needle) => value.includes(needle))) {
		return 'load-targets';
	}
	return '';
}

function normalizeRestRows(rawRows) {
	return (Array.isArray(rawRows) ? rawRows : [])
		.filter(isPlainObject)
		.map((row) => {
			const url = String(row.url || row.name || '');
			const label = row.label || restLabelForUrl(url) || 'rest';
			const payloadBytes = round(
				finiteNumber(row.payload_bytes)
				?? finiteNumber(row.payloadBytes)
				?? finiteNumber(row.responseBodyBytes)
				?? finiteNumber(row.decodedBodySize)
				?? finiteNumber(row.encodedBodySize)
				?? finiteNumber(row.transferSize)
			);
			return {
				label,
				method: row.method || null,
				url,
				status: typeof row.status === 'number' ? row.status : null,
				start_ms: round(finiteNumber(row.start_ms) ?? finiteNumber(row.startMs) ?? finiteNumber(row.startTime)),
				end_ms: round(finiteNumber(row.end_ms) ?? finiteNumber(row.endMs) ?? finiteNumber(row.responseEnd)),
				duration_ms: round(finiteNumber(row.duration_ms) ?? finiteNumber(row.durationMs) ?? finiteNumber(row.duration)),
				payload_bytes: payloadBytes,
			};
		});
}

function totalPayloadBytes(restRows) {
	return restRows.reduce((total, row) => total + (row.payload_bytes || 0), 0);
}

function restTimingMs(row) {
	return finiteNumber(row?.duration_ms) ?? (
		finiteNumber(row?.start_ms) !== null && finiteNumber(row?.end_ms) !== null
			? row.end_ms - row.start_ms
			: null
	);
}

function blueprintStepCountFromTarget(target) {
	const steps = target?.preview?.blueprint?.steps || target?.blueprint?.steps || target?.preview_blueprint?.steps;
	return Array.isArray(steps) ? steps.length : null;
}

function findPreparedSnapshotHit(value, depth = 0) {
	if (!isPlainObject(value) || depth > 5) {
		return null;
	}
	for (const key of ['prepared_snapshot_hit', 'preparedSnapshotHit', 'snapshot_hit', 'snapshotHit', 'cache_hit', 'cacheHit']) {
		if (typeof value[key] === 'boolean') {
			return value[key];
		}
	}
	if (isPlainObject(value.prepared_snapshot) && typeof value.prepared_snapshot.hit === 'boolean') {
		return value.prepared_snapshot.hit;
	}
	if (isPlainObject(value.preparedSnapshot) && typeof value.preparedSnapshot.hit === 'boolean') {
		return value.preparedSnapshot.hit;
	}
	for (const item of Object.values(value)) {
		const found = findPreparedSnapshotHit(item, depth + 1);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

function responseJsonRows(rawRows) {
	return (Array.isArray(rawRows) ? rawRows : [])
		.map((row) => row?.json || safeJsonParse(row?.body || row?.bodyText || ''))
		.filter(isPlainObject);
}

function preparedSnapshotHitFromInput(input, preparedTarget, parsedResponses) {
	if (typeof input.prepared_snapshot_hit === 'boolean') {
		return input.prepared_snapshot_hit;
	}
	if (typeof input.preparedSnapshotHit === 'boolean') {
		return input.preparedSnapshotHit;
	}
	return findPreparedSnapshotHit(preparedTarget) ?? parsedResponses.map(findPreparedSnapshotHit).find((hit) => hit !== null) ?? null;
}

function cacheStateFromSnapshotHit(hit) {
	if (hit === true) {
		return 'warm';
	}
	if (hit === false) {
		return 'cold';
	}
	return null;
}

function statusFromReadiness(inputStatus, missingStartupPhases, metrics) {
	if (inputStatus) {
		return inputStatus;
	}
	if (missingStartupPhases.length === 0 || metrics.editable_preview_ready_ms !== null) {
		return 'passed';
	}
	return 'incomplete';
}

function preparedSnapshotLabel(value) {
	if (value === true) {
		return 'hit';
	}
	if (value === false) {
		return 'miss';
	}
	return 'unknown';
}

function previewSessionLabel(previewSession) {
	if (previewSession.skipped) {
		return 'skipped';
	}
	if (previewSession.ready) {
		return 'ready';
	}
	return previewSession.status || 'unknown';
}

function metricSuffix(key) {
	if (key.endsWith('_bytes') || key === 'payload_bytes') {
		return ' bytes';
	}
	if (key.endsWith('_ms')) {
		return ' ms';
	}
	return '';
}

function summarizeStudioWebPreviewStartup(input = {}) {
	const performance = input.startupPerformance || input.performance || input.studioWebPerformance || {};
	const phases = normalizePhases(input.phases || performance.phases || []);
	const restRows = normalizeRestRows(input.rest || input.restPayloads || input.restPayloadDiagnostics || []);
	const parsedResponses = responseJsonRows(input.rest || input.restPayloads || input.restPayloadDiagnostics || []);
	const targetsRow = restRows.find((row) => row.label === 'load-targets') || null;
	const previewSessionRow = restRows.find((row) => row.label === 'prepare-preview-session') || null;
	const preparedTarget = input.readyTarget || input.target || parsedResponses.map((row) => row.target).find(isPlainObject) || null;
	const blueprintStepCount = finiteNumber(input.blueprint_step_count)
		?? finiteNumber(input.blueprintStepCount)
		?? blueprintStepCountFromTarget(preparedTarget)
		?? parsedResponses.map((row) => blueprintStepCountFromTarget(row.target || row)).find((count) => count !== null)
		?? null;
	const editablePhase = firstPhase(phases, ['editable_preview_ready', 'preview_ready_for_generation']);
	const metrics = {
		host_page_ready_ms: round(
			finiteNumber(input.host_page_ready_ms)
			?? finiteNumber(input.hostPageReadyMs)
			?? phaseElapsedMs(firstPhase(phases, ['host_page_loaded', 'studio_web_ui_ready']))
		),
		targets_fetch_ms: round(finiteNumber(input.targets_fetch_ms) ?? finiteNumber(input.targetsFetchMs) ?? restTimingMs(targetsRow)),
		preview_session_ready_ms: round(finiteNumber(input.preview_session_ready_ms) ?? finiteNumber(input.previewSessionReadyMs) ?? restTimingMs(previewSessionRow)),
		rest_count: restRows.length,
		payload_bytes: round(finiteNumber(input.payload_bytes) ?? finiteNumber(input.payloadBytes) ?? totalPayloadBytes(restRows)),
		blueprint_step_count: round(blueprintStepCount),
		playground_client_loaded_ms: round(phaseElapsedMs(firstPhase(phases, 'playground_client_module_loaded'))),
		blueprint_complete_ms: round(phaseElapsedMs(firstPhase(phases, 'blueprint_run_complete'))),
		visible_iframe_ready_ms: round(phaseElapsedMs(firstPhase(phases, 'visible_playground_iframe_ready'))),
		editable_preview_ready_ms: round(phaseElapsedMs(editablePhase)),
	};
	const preparedSnapshotHit = preparedSnapshotHitFromInput(input, preparedTarget, parsedResponses);
	const missingStartupPhases = REQUIRED_STARTUP_PHASES.filter((name) => !firstPhase(phases, name));
	const previewSessionSkipped = Boolean(input.preview_session_skipped || input.previewSessionSkipped || (!previewSessionRow && input.previewSessionOptional));
	const status = statusFromReadiness(input.status, missingStartupPhases, metrics);

	return {
		schema: SCHEMA,
		id: input.id || input.run_id || input.runId || 'studio-web-preview-startup',
		label: input.label || input.ref || null,
		ref: input.ref || null,
		cache_state: input.cache_state || input.cacheState || cacheStateFromSnapshotHit(preparedSnapshotHit),
		status,
		metrics,
		prepared_snapshot_hit: preparedSnapshotHit,
		preview_session: {
			status: preparedTarget?.preview?.session?.status || input.previewSessionStatus || null,
			ready: preparedTarget?.preview?.session?.status === 'ready' || input.previewSessionReady === true,
			skipped: previewSessionSkipped,
		},
		readiness: {
			missing_startup_phases: missingStartupPhases,
			has_playground_client: metrics.playground_client_loaded_ms !== null,
			has_blueprint_complete: metrics.blueprint_complete_ms !== null,
			has_visible_iframe: metrics.visible_iframe_ready_ms !== null,
			has_editable_preview: metrics.editable_preview_ready_ms !== null,
		},
		rest: {
			count: restRows.length,
			payload_bytes: metrics.payload_bytes,
			rows: restRows,
		},
		phases,
		metadata: {
			url: input.url || null,
			started_at: input.started_at || input.startedAt || null,
			completed_at: input.completed_at || input.completedAt || null,
		},
	};
}

function metricDelta(baseline, candidate, key) {
	const before = finiteNumber(baseline?.metrics?.[key]);
	const after = finiteNumber(candidate?.metrics?.[key]);
	const delta = before === null || after === null ? null : after - before;
	const percentDelta = before === null || after === null || before === 0 ? null : ((after - before) / before) * 100;
	return {
		key,
		baseline: before,
		candidate: after,
		delta,
		percent_delta: percentDelta,
	};
}

function compareStudioWebPreviewStartupBenchmarks({ baseline, candidate }) {
	const normalizedBaseline = baseline?.schema === SCHEMA ? baseline : summarizeStudioWebPreviewStartup(baseline || {});
	const normalizedCandidate = candidate?.schema === SCHEMA ? candidate : summarizeStudioWebPreviewStartup(candidate || {});
	return {
		schema: COMPARISON_SCHEMA,
		baseline: {
			label: normalizedBaseline.label,
			ref: normalizedBaseline.ref,
			cache_state: normalizedBaseline.cache_state,
			status: normalizedBaseline.status,
		},
		candidate: {
			label: normalizedCandidate.label,
			ref: normalizedCandidate.ref,
			cache_state: normalizedCandidate.cache_state,
			status: normalizedCandidate.status,
		},
		metrics: METRIC_KEYS.map((key) => metricDelta(normalizedBaseline, normalizedCandidate, key)),
	};
}

function formatNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : '';
}

function formatDelta(value, suffix = '') {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return '';
	}
	const sign = value > 0 ? '+' : '';
	return `${sign}${Math.round(value)}${suffix}`;
}

function metricLabel(key) {
	return key.replace(/_/g, ' ');
}

function formatStudioWebPreviewStartupMarkdownReport(result, options = {}) {
	const summary = result?.schema === SCHEMA ? result : summarizeStudioWebPreviewStartup(result || {});
	const title = options.title || 'Studio Web Preview Startup Benchmark';
	const lines = [
		`# ${title}`,
		'',
		`- **Run:** ${summary.label || summary.id}`,
		`- **Status:** ${summary.status}`,
		`- **Cache state:** ${summary.cache_state || 'unknown'}`,
		`- **Prepared snapshot:** ${preparedSnapshotLabel(summary.prepared_snapshot_hit)}`,
		`- **Preview session:** ${previewSessionLabel(summary.preview_session)}`,
		'',
		'| Metric | Value |',
		'|---|---:|',
	];
	for (const key of METRIC_KEYS) {
		const suffix = metricSuffix(key);
		lines.push(`| ${metricLabel(key)} | ${formatNumber(summary.metrics[key])}${summary.metrics[key] === null ? '' : suffix} |`);
	}
	if (summary.readiness.missing_startup_phases.length) {
		lines.push('', `Missing startup phases: ${summary.readiness.missing_startup_phases.map((phase) => `\`${phase}\``).join(', ')}`);
	}
	return `${lines.join('\n')}\n`;
}

function formatStudioWebPreviewStartupComparisonMarkdownReport(comparison, options = {}) {
	const normalized = comparison?.schema === COMPARISON_SCHEMA
		? comparison
		: compareStudioWebPreviewStartupBenchmarks(comparison || {});
	const title = options.title || 'Studio Web Preview Startup Comparison';
	const lines = [
		`# ${title}`,
		'',
		`- **Baseline:** ${normalized.baseline.label || normalized.baseline.ref || 'baseline'} (${normalized.baseline.cache_state || 'unknown'})`,
		`- **Candidate:** ${normalized.candidate.label || normalized.candidate.ref || 'candidate'} (${normalized.candidate.cache_state || 'unknown'})`,
		'',
		'| Metric | Baseline | Candidate | Delta | Delta % |',
		'|---|---:|---:|---:|---:|',
	];
	for (const metric of normalized.metrics) {
		const suffix = metricSuffix(metric.key);
		lines.push(`| ${metricLabel(metric.key)} | ${formatNumber(metric.baseline)} | ${formatNumber(metric.candidate)} | ${formatDelta(metric.delta, suffix)} | ${formatDelta(metric.percent_delta, '%')} |`);
	}
	return `${lines.join('\n')}\n`;
}

async function responsePayloadBytes(response) {
	const header = response.headers?.()['content-length'];
	const headerBytes = Number.parseInt(header || '', 10);
	if (Number.isFinite(headerBytes) && headerBytes >= 0) {
		return headerBytes;
	}
	try {
		return Buffer.byteLength(await response.text());
	} catch {
		return null;
	}
}

async function responseJson(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function runStudioWebPreviewStartupBenchmark(options = {}) {
	const { page } = options;
	if (!page || typeof page.goto !== 'function') {
		throw new TypeError('runStudioWebPreviewStartupBenchmark requires a Playwright page');
	}
	if (typeof options.url !== 'string' || options.url.trim() === '') {
		throw new TypeError('runStudioWebPreviewStartupBenchmark requires url');
	}

	const startedAt = new Date().toISOString();
	const started = Date.now();
	const restRows = [];
	const onResponse = async (response) => {
		const url = response.url();
		const label = restLabelForUrl(url);
		if (!label) {
			return;
		}
		const request = response.request();
		const endMs = Date.now() - started;
		restRows.push({
			label,
			method: request.method(),
			url,
			status: response.status(),
			end_ms: endMs,
			payload_bytes: await responsePayloadBytes(response),
			json: await responseJson(response),
		});
	};
	page.on('response', onResponse);
	try {
		await page.goto(options.url, { waitUntil: options.waitUntil || 'domcontentloaded' });
		const hostPageReadyMs = Date.now() - started;
		const timeoutMs = Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs > 0 ? options.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS;
		await page.waitForFunction(() => {
			const root = document.querySelector('[data-studio-web-preview]');
			const status = document.querySelector('[data-studio-web-generation-status]')?.textContent || '';
			const phases = Array.isArray(window.studioWebPerformance?.snapshot?.()?.phases) ? window.studioWebPerformance.snapshot().phases : [];
			const required = ['playground_client_module_loaded', 'blueprint_run_complete', 'visible_playground_iframe_ready'];
			const hasRequired = required.every((name) => phases.some((phase) => phase?.phase === name || phase?.name === name));
			return root?.classList.contains('has-error') || (window.studioWebPreviewClient && (hasRequired || root?.classList.contains('is-ready') || status === 'Site ready'));
		}, { timeout: timeoutMs });
		const pageSnapshot = await page.evaluate(() => ({
			startupPerformance: window.studioWebPerformance?.snapshot?.() || null,
			statusText: document.querySelector('[data-studio-web-generation-status]')?.textContent || '',
			rootState: {
				isReady: document.querySelector('[data-studio-web-preview]')?.classList.contains('is-ready') || false,
				hasError: document.querySelector('[data-studio-web-preview]')?.classList.contains('has-error') || false,
				generationPhase: document.querySelector('[data-studio-web-preview]')?.dataset?.generationPhase || '',
			},
		}));
		return summarizeStudioWebPreviewStartup({
			...pageSnapshot,
			id: options.id,
			label: options.label,
			ref: options.ref,
			cache_state: options.cacheState,
			url: options.url,
			started_at: startedAt,
			completed_at: new Date().toISOString(),
			host_page_ready_ms: hostPageReadyMs,
			rest: restRows,
		});
	} finally {
		page.off('response', onResponse);
	}
}

function readJsonFile(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseCliArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--input') {
			options.input = argv[++index];
		} else if (arg === '--baseline') {
			options.baseline = argv[++index];
		} else if (arg === '--candidate') {
			options.candidate = argv[++index];
		} else if (arg === '--markdown') {
			options.markdown = true;
		} else if (arg === '--json') {
			options.json = true;
		}
	}
	return options;
}

function cli(argv) {
	const options = parseCliArgs(argv);
	if (options.baseline && options.candidate) {
		const comparison = compareStudioWebPreviewStartupBenchmarks({
			baseline: readJsonFile(options.baseline),
			candidate: readJsonFile(options.candidate),
		});
		process.stdout.write(options.markdown
			? formatStudioWebPreviewStartupComparisonMarkdownReport(comparison)
			: `${JSON.stringify(comparison, null, 2)}\n`);
		return;
	}
	if (options.input) {
		const summary = summarizeStudioWebPreviewStartup(readJsonFile(options.input));
		process.stdout.write(options.markdown
			? formatStudioWebPreviewStartupMarkdownReport(summary)
			: `${JSON.stringify(summary, null, 2)}\n`);
		return;
	}
	throw new Error('Usage: node studio-web-preview-startup-benchmark.js --input <run.json> [--markdown] OR --baseline <baseline.json> --candidate <candidate.json> [--markdown]');
}

if (require.main === module) {
	cli(process.argv.slice(2));
}

module.exports = {
	COMPARISON_SCHEMA,
	METRIC_KEYS,
	REQUIRED_STARTUP_PHASES,
	SCHEMA,
	compareStudioWebPreviewStartupBenchmarks,
	formatStudioWebPreviewStartupComparisonMarkdownReport,
	formatStudioWebPreviewStartupMarkdownReport,
	runStudioWebPreviewStartupBenchmark,
	summarizeStudioWebPreviewStartup,
};
