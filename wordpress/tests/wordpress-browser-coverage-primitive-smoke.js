'use strict';

const assert = require('node:assert/strict');
const {
  browserCoverageRecipe,
  browserCoverageTargetsFromArgs,
  browserCoverageTargetsFromWorkload,
  parseStepArgs,
} = require('../lib/wordpress-browser-coverage-primitive');

assert.deepEqual(parseStepArgs(['surface=admin_pages', 'paths=/wp-admin/index.php,/wp-admin/edit.php?post_type=page']), {
  surface: 'admin_pages',
  paths: '/wp-admin/index.php,/wp-admin/edit.php?post_type=page',
});

assert.deepEqual(browserCoverageTargetsFromArgs({ surface: 'admin_pages', paths: '/wp-admin/index.php,/wp-admin/plugins.php' }), [
  { path: 'index.php', surface: 'admin' },
  { path: 'plugins.php', surface: 'admin' },
]);

const workload = {
  cases: [
    {
      phases: {
        action: [
          { command: 'wordpress.run-declarative-fuzz', args: ['surface=frontend_rendering', 'paths=/,/shop/,/cart/'] },
          { command: 'wordpress.trace-browser-coverage', args: ['surface=admin', 'paths=/wp-admin/edit.php'] },
        ],
      },
    },
  ],
};

assert.deepEqual(browserCoverageTargetsFromWorkload(workload), [
  { path: '/', surface: 'frontend' },
  { path: '/shop/', surface: 'frontend' },
  { path: '/cart/', surface: 'frontend' },
  { path: 'edit.php', surface: 'admin' },
]);

const recipe = browserCoverageRecipe({ workload, args: { capture: 'network' }, wpVersion: 'latest' });
assert.equal(recipe.schema, 'wp-codebox/workspace-recipe/v1');
assert.equal(recipe.runtime.wp, 'latest');
assert.deepEqual(recipe.workflow.steps.map((step) => step.command), [
  'wordpress.browser-page-load',
  'wordpress.browser-page-load',
  'wordpress.browser-page-load',
  'wordpress.browser-page-load',
]);
assert.deepEqual(recipe.workflow.steps[0].args, ['capture=network', 'surface=frontend', 'path=/']);
assert.deepEqual(recipe.workflow.steps[3].args, ['capture=network', 'surface=admin', 'path=edit.php']);

console.log('wordpress browser coverage primitive smoke passed');
