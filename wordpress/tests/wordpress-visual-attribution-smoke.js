'use strict';

const assert = require('node:assert/strict');
const { normalizeWordPressVisualAttribution } = require('../lib/wordpress-visual-attribution');

const snapshot = { schema: 'wp-codebox/browser-dom-snapshot/v1', snapshot: { capturedElements: [] } };
const attribution = normalizeWordPressVisualAttribution({
	visualDiff: { comparison: { mismatchRatio: 0.2, mismatchPixels: 200, totalPixels: 1000, dimensionMismatch: false }, limitations: [ 'pixel evidence is available' ] },
	visualExplanation: {
		schema: 'wp-codebox/visual-explanation/v1',
		summary: { changedElements: 1, addedElements: 1, removedElements: 1 },
		mismatchRegions: [ { x: 10, y: 20, width: 30, height: 40, pixels: 90, sourceElements: [ { path: 'main > p', tag: 'p', boundingBox: { x: 10 }, overlap: { area: 80 } } ], candidateElements: [ { path: 'main > p', tag: 'p', boundingBox: { x: 12 }, overlap: { area: 80 } } ] } ],
		selectorDeltas: [ { selector: '.notice', sourcePath: 'main > p', candidatePath: 'main > p', boundingBox: { source: { x: 1 }, candidate: { x: 3 }, delta: { x: 2, y: 0, width: 0, height: 0 }, severity: 'warning' }, styles: [ { property: 'font-size', source: '16px', candidate: '18px', category: 'typography', severity: 'warning', hint: 'Text changed.' }, { property: 'background-color', source: 'red', candidate: 'blue', category: 'paint', severity: 'warning', hint: 'Paint changed.' } ] } ],
		changes: [ { path: 'main > p', tag: 'p', changes: { boundingBox: {} } } ],
		added: [ { path: 'main > aside', tag: 'aside', text: 'New', boundingBox: { x: 1 } } ],
		removed: [ { path: 'main > nav', tag: 'nav', text: 'Old', boundingBox: { x: 1 } } ],
	},
	sourceDomSnapshot: snapshot,
	candidateDomSnapshot: snapshot,
	candidateProvenance: { 'main > p': { source_file: 'template.html', line: 12 }, 'main > aside': { source_file: 'sidebar.html' } },
	refs: { visualExplanation: 'visual-explanation.json', sourceDomSnapshot: 'source-dom.json', candidateDomSnapshot: 'candidate-dom.json' },
	limits: { maxFindings: 2, maxRegions: 1, maxElementChanges: 1, maxStyleDeltas: 1 },
});

assert.equal(attribution.schema, 'homeboy/WordPressVisualAttribution/v1');
assert.equal(attribution.pixel_summary.mismatch_pixels, 200);
assert.equal(attribution.mismatch_regions[0].source_elements[0].path, 'main > p');
assert.equal(attribution.mismatch_regions[0].candidate_elements[0].overlap.area, 80);
assert.deepEqual(attribution.selector_deltas[0].bounding_box.delta, { x: 2, y: 0, width: 0, height: 0 });
assert.equal(attribution.computed_style_deltas.typography.length, 1);
assert.equal(attribution.computed_style_deltas.paint.length, 0, 'style limit bounds emitted style evidence');
assert.equal(attribution.elements.changed[0].provenance.line, 12);
assert.equal(attribution.elements.added[0].provenance.source_file, 'sidebar.html');
assert.equal(attribution.elements.removed[0].path, 'main > nav');
assert.equal(attribution.top_findings.length, 2);
assert.equal(attribution.evidence.candidate_dom_snapshot.path, 'candidate-dom.json');

const pixelOnly = normalizeWordPressVisualAttribution({ visualDiff: { comparison: { mismatchPixels: 1, totalPixels: 2 } } });
assert.equal(pixelOnly.pixel_summary.mismatch_ratio, 0);
assert.equal(pixelOnly.top_findings.length, 0);
assert.equal(pixelOnly.limitations.some(( limitation ) => limitation.includes('explanation evidence is unavailable')), true);
assert.equal(pixelOnly.limitations.some(( limitation ) => limitation.includes('DOM snapshot evidence is unavailable')), true);

console.log('WordPress visual attribution smoke passed.');
