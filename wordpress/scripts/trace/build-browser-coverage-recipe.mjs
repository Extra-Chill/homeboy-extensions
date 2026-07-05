#!/usr/bin/env node
/**
 * External dependencies
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

/**
 * Internal dependencies
 */
const { browserCoverageRecipe, parseStepArgs, readJsonFile } = require('../../lib/wordpress-browser-coverage-primitive.js');

const [outputFile] = process.argv.slice(2);
if (!outputFile) {
  process.stderr.write('Usage: build-browser-coverage-recipe.mjs <output-file>\n');
  process.exit(2);
}

const workloadFile = process.env.HOMEBOY_TRACE_BROWSER_COVERAGE_WORKLOAD || '';
const argsJson = process.env.HOMEBOY_TRACE_BROWSER_COVERAGE_ARGS_JSON || '{}';
const argsLine = process.env.HOMEBOY_TRACE_BROWSER_COVERAGE_ARGS || '';
const mountsJson = process.env.HOMEBOY_TRACE_BROWSER_COVERAGE_MOUNTS_JSON || '[]';
const blueprintJson = process.env.HOMEBOY_TRACE_BROWSER_COVERAGE_BLUEPRINT_JSON || '{"steps":[]}';

const args = {
  ...JSON.parse(argsJson),
  ...parseStepArgs(argsLine ? argsLine.split(/\s+/) : []),
};
const recipe = browserCoverageRecipe({
  workload: workloadFile ? readJsonFile(workloadFile) : undefined,
  args,
  mounts: JSON.parse(mountsJson),
  blueprint: JSON.parse(blueprintJson),
  wpVersion: process.env.HOMEBOY_TRACE_BROWSER_COVERAGE_WP_VERSION || '',
});

fs.writeFileSync(outputFile, `${JSON.stringify(recipe, null, 2)}\n`);
