'use strict';

/**
 * External dependencies
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Internal dependencies
 */
const {
	compareStudioWebPreviewStartupBenchmarks,
	formatStudioWebPreviewStartupComparisonMarkdownReport,
	formatStudioWebPreviewStartupMarkdownReport,
	summarizeStudioWebPreviewStartup,
} = require('../lib/studio-web-preview-startup-benchmark');

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function withTempDirectory(callback) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-web-preview-startup-'));
	try {
		callback(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

const coldRaw = {
	id: 'cold-start',
	label: 'baseline cold',
	ref: 'main',
	url: 'https://studio-web.test/import',
	startupPerformance: {
		phases: [
			{ phase: 'host_page_loaded', elapsed_ms: 40 },
			{ phase: 'studio_web_ui_ready', elapsed_ms: 75 },
			{ phase: 'playground_client_module_loaded', elapsed_ms: 410 },
			{ phase: 'blueprint_run_complete', elapsed_ms: 2200, since_previous_ms: 1790 },
			{ phase: 'visible_playground_iframe_ready', elapsed_ms: 2310, since_previous_ms: 110 },
			{ phase: 'editable_preview_ready', elapsed_ms: 2500, status: 'complete' },
		],
	},
	restPayloadDiagnostics: [
		{
			label: 'load-targets',
			method: 'GET',
			url: 'https://studio-web.test/wp-json/studio-web/v1/targets',
			status: 200,
			duration_ms: 120,
			payload_bytes: 800,
		},
		{
			label: 'prepare-preview-session',
			method: 'POST',
			url: 'https://studio-web.test/wp-json/studio-web/v1/targets/preview-session',
			status: 200,
			duration_ms: 300,
			payload_bytes: 1200,
			json: {
				target: {
					preview: {
						session: { schema: 'wp-codebox/browser-playground-session/v1', status: 'ready' },
						blueprint: { steps: [{ step: 'login' }, { step: 'activatePlugin' }, { step: 'runPHP' }] },
						runtime: { prepared_snapshot: { hit: false } },
					},
				},
			},
		},
	],
};

const coldSummary = summarizeStudioWebPreviewStartup(coldRaw);
assert.equal(coldSummary.schema, 'homeboy/studio-web-preview-startup-benchmark/v1');
assert.equal(coldSummary.status, 'passed');
assert.equal(coldSummary.cache_state, 'cold');
assert.equal(coldSummary.prepared_snapshot_hit, false);
assert.equal(coldSummary.preview_session.ready, true);
assert.equal(coldSummary.metrics.host_page_ready_ms, 40);
assert.equal(coldSummary.metrics.targets_fetch_ms, 120);
assert.equal(coldSummary.metrics.preview_session_ready_ms, 300);
assert.equal(coldSummary.metrics.rest_count, 2);
assert.equal(coldSummary.metrics.payload_bytes, 2000);
assert.equal(coldSummary.metrics.blueprint_step_count, 3);
assert.equal(coldSummary.metrics.playground_client_loaded_ms, 410);
assert.equal(coldSummary.metrics.blueprint_complete_ms, 2200);
assert.equal(coldSummary.metrics.visible_iframe_ready_ms, 2310);
assert.equal(coldSummary.metrics.editable_preview_ready_ms, 2500);
assert.deepEqual(coldSummary.readiness.missing_startup_phases, []);

const warmSummary = summarizeStudioWebPreviewStartup({
	...coldRaw,
	id: 'warm-start',
	label: 'candidate warm',
	ref: 'fix/fast-path',
	startupPerformance: {
		phases: [
			{ phase: 'host_page_loaded', elapsed_ms: 35 },
			{ phase: 'playground_client_module_loaded', elapsed_ms: 120 },
			{ phase: 'blueprint_run_complete', elapsed_ms: 600 },
			{ phase: 'visible_playground_iframe_ready', elapsed_ms: 650 },
			{ phase: 'editable_preview_ready', elapsed_ms: 700, status: 'complete' },
		],
	},
	restPayloadDiagnostics: [{
		label: 'prepare-preview-session',
		status: 200,
		duration_ms: 50,
		payload_bytes: 900,
		json: {
			target: {
				preview: {
					session: { schema: 'wp-codebox/browser-playground-session/v1', status: 'ready' },
					blueprint: { steps: [{ step: 'login' }] },
					prepared_snapshot_hit: true,
				},
			},
		},
	}],
});
assert.equal(warmSummary.cache_state, 'warm');
assert.equal(warmSummary.prepared_snapshot_hit, true);
assert.equal(warmSummary.metrics.blueprint_step_count, 1);

const comparison = compareStudioWebPreviewStartupBenchmarks({ baseline: coldSummary, candidate: warmSummary });
const editableDelta = comparison.metrics.find((metric) => metric.key === 'editable_preview_ready_ms');
assert.equal(editableDelta.baseline, 2500);
assert.equal(editableDelta.candidate, 700);
assert.equal(editableDelta.delta, -1800);
assert.equal(Math.round(editableDelta.percent_delta), -72);

const summaryMarkdown = formatStudioWebPreviewStartupMarkdownReport(coldSummary);
assert.match(summaryMarkdown, /# Studio Web Preview Startup Benchmark/);
assert.match(summaryMarkdown, /Prepared snapshot:\*\* miss/);
assert.match(summaryMarkdown, /blueprint step count \| 3/);

const comparisonMarkdown = formatStudioWebPreviewStartupComparisonMarkdownReport(comparison);
assert.match(comparisonMarkdown, /# Studio Web Preview Startup Comparison/);
assert.match(comparisonMarkdown, /editable preview ready ms/);
assert.match(comparisonMarkdown, /-1800 ms/);

withTempDirectory((root) => {
	const rawPath = path.join(root, 'raw.json');
	const baselinePath = path.join(root, 'baseline.json');
	const candidatePath = path.join(root, 'candidate.json');
	writeJson(rawPath, coldRaw);
	writeJson(baselinePath, coldSummary);
	writeJson(candidatePath, warmSummary);

	const cliPath = path.join(__dirname, '..', 'lib', 'studio-web-preview-startup-benchmark.js');
	const jsonResult = spawnSync(process.execPath, [cliPath, '--input', rawPath], { encoding: 'utf8' });
	assert.equal(jsonResult.status, 0, jsonResult.stderr);
	assert.equal(JSON.parse(jsonResult.stdout).metrics.payload_bytes, 2000);

	const markdownResult = spawnSync(process.execPath, [cliPath, '--baseline', baselinePath, '--candidate', candidatePath, '--markdown'], { encoding: 'utf8' });
	assert.equal(markdownResult.status, 0, markdownResult.stderr);
	assert.match(markdownResult.stdout, /candidate warm/);
});

console.log('✓ Studio Web preview startup benchmark smoke test PASSED');
