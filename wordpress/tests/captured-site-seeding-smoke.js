'use strict';

const assert = require('node:assert/strict');

const {
  buildCapturedSiteSeedWorkloadStep,
  normalizeCapturedSiteManifest,
} = require('../lib/captured-site-seeding');

const seed = normalizeCapturedSiteManifest({
  posts: [{ type: 'page', title: 'Public captured page', slug: 'captured-page', content: '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->' }],
  options: {
    blogname: 'Captured Site',
    api_token: 'redacted-but-sensitive-key',
    local_preview: 'http://localhost:8881/private',
  },
  plugin_state: [{ plugin: 'demo-plugin', state: { enabled: true, count: 3 } }],
}, { role: 'source' });

assert.equal(seed.role, 'source');
assert.equal(seed.posts.length, 1);
assert.equal(seed.options.length, 1);
assert.equal(seed.options[0].name, 'blogname');
assert.equal(seed.pluginState.length, 1);
assert.equal(seed.summary.blocked.length >= 2, true);

const step = buildCapturedSiteSeedWorkloadStep(seed);
assert.equal(step.type, 'php');
assert.match(step.code, /wp_insert_post/);
assert.match(step.code, /homeboy_captured_site_seed_source/);
assert.match(step.code, /blocked_seed_items/);

console.log('captured-site seeding smoke passed');
