'use strict';

/**
 * External dependencies
 */
const fs = require('node:fs');

const DEFAULT_CAPTURE = 'network,console,errors,html';

function parseStepArgs(args = []) {
  const parsed = {};
  for (const arg of args) {
    const [key, ...rest] = String(arg).split('=');
    if (!key) {
      continue;
    }
    parsed[key] = rest.length > 0 ? rest.join('=') : '';
  }
  return parsed;
}

function csv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSurface(value) {
  const surface = String(value || '').trim();
  if (surface === 'admin' || surface === 'admin_pages' || surface === 'wp-admin') {
    return 'admin';
  }
  return 'frontend';
}

function targetFromPath(path, surface) {
  if (/^https?:\/\//i.test(path)) {
    return { url: path, surface };
  }
  if (path.startsWith('/wp-admin/')) {
    return { path: path.slice('/wp-admin/'.length), surface: 'admin' };
  }
  return { path, surface };
}

function browserCoverageTargetsFromArgs(args = {}) {
  const surface = normalizeSurface(args.surface);
  const paths = csv(args.paths || args.path);
  const urls = csv(args.urls || args.url);
  const targets = [
    ...paths.map((path) => targetFromPath(path, surface)),
    ...urls.map((url) => ({ url, surface })),
  ];
  return targets.length > 0 ? targets : [targetFromPath(surface === 'admin' ? '/wp-admin/index.php' : '/', surface)];
}

function browserCoverageTargetsFromWorkload(workload) {
  const targets = [];
  for (const item of workload?.cases || []) {
    for (const phase of ['setup', 'action', 'assert']) {
      for (const step of item?.phases?.[phase] || []) {
        const command = String(step?.command || '');
        if (!['wordpress.trace-browser-coverage', 'wordpress.run-declarative-fuzz'].includes(command)) {
          continue;
        }
        targets.push(...browserCoverageTargetsFromArgs(parseStepArgs(step.args || [])));
      }
    }
  }
  return targets;
}

function browserCoverageRecipe({ workload, args = {}, mounts = [], wpVersion = '', blueprint = {}, capture = DEFAULT_CAPTURE } = {}) {
  const workloadTargets = browserCoverageTargetsFromWorkload(workload);
  const targets = workloadTargets.length > 0 ? workloadTargets : browserCoverageTargetsFromArgs(args);
  const steps = targets.map((target) => {
    const stepArgs = [
      `capture=${args.capture || capture}`,
      `surface=${target.surface || normalizeSurface(args.surface)}`,
      ...(target.url ? [`url=${target.url}`] : [`path=${target.path || '/'}`]),
      ...(args['wait-for'] ? [`wait-for=${args['wait-for']}`] : []),
      ...(args.duration ? [`duration=${args.duration}`] : []),
    ];
    return { command: 'wordpress.browser-page-load', args: stepArgs };
  });

  return {
    schema: 'wp-codebox/workspace-recipe/v1',
    runtime: {
      blueprint,
      ...(wpVersion ? { wp: wpVersion } : {}),
    },
    inputs: { mounts },
    workflow: { steps },
  };
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  DEFAULT_BROWSER_COVERAGE_CAPTURE: DEFAULT_CAPTURE,
  browserCoverageRecipe,
  browserCoverageTargetsFromArgs,
  browserCoverageTargetsFromWorkload,
  parseStepArgs,
  readJsonFile,
};
