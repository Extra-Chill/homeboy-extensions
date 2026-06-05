'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { compileConductorTransferRigs } = require('../lib/conductor-transfer-workload');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homeboy-conductor-transfer-'));

try {
  const extensionPath = path.join(__dirname, '..');
  const componentPath = path.join(root, 'conductor-transfer-fixture');
  fs.mkdirSync(path.join(componentPath, 'rigs'), { recursive: true });
  fs.mkdirSync(path.join(componentPath, 'tests', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(componentPath, 'conductor-transfer-fixture.php'), "<?php\n/* Plugin Name: Conductor Transfer Fixture */\n");

  fs.writeFileSync(path.join(componentPath, 'rigs', 'source.json'), JSON.stringify({
    posts: [{ type: 'page', title: 'Source page', slug: 'source-page', content: 'source' }],
    options: { blogname: 'Source' },
  }, null, 2));
  fs.writeFileSync(path.join(componentPath, 'rigs', 'target.json'), JSON.stringify({
    posts: [{ type: 'page', title: 'Target page', slug: 'target-page', content: 'target' }],
    plugin_state: [{ plugin: 'demo-transfer-plugin', state: { imported: true } }],
  }, null, 2));
  fs.writeFileSync(path.join(componentPath, 'rigs', 'sandbox.json'), JSON.stringify({
    options: { blogdescription: 'Sandbox' },
  }, null, 2));
  fs.writeFileSync(path.join(componentPath, 'rigs', 'transfer.json'), JSON.stringify({
    id: 'synthetic-transfer',
    label: 'Synthetic transfer',
    source_manifest: 'source.json',
    target_manifest: 'target.json',
    sandbox_manifest: 'sandbox.json',
    run: [{ type: 'php', code: "return ['metrics' => ['transfer_step_seen' => 1]];" }],
  }, null, 2));

  const compiled = compileConductorTransferRigs({ componentPath, rigs: ['rigs/transfer.json'] });
  assert.equal(compiled.schema, 'homeboy/wordpress-conductor-transfer-rigs/v1');
  assert.equal(compiled.workloads.length, 1);
  assert.equal(compiled.workloads[0].id, 'synthetic-transfer');
  assert.equal(compiled.workloads[0].run.filter((step) => step.type === 'php').length >= 5, true);
  assert.equal(compiled.workloads[0].metadata.source_seed.seeded.some((entry) => entry.kind === 'post'), true);

  const captureFile = path.join(root, 'captured-recipe.json');
  const fakeWpCodebox = path.join(root, 'fixture-wp-codebox.js');
  fs.writeFileSync(fakeWpCodebox, `#!/usr/bin/env node
const fs = require('node:fs');
const recipeIndex = process.argv.indexOf('--recipe');
if (process.argv[2] !== 'recipe-run' || recipeIndex < 0) {
  process.exit(2);
}
const recipe = JSON.parse(fs.readFileSync(process.argv[recipeIndex + 1], 'utf8'));
fs.writeFileSync(process.env.HOMEBOY_CAPTURE_RECIPE, JSON.stringify(recipe, null, 2) + '\\n');
process.stdout.write(JSON.stringify({
  success: true,
  benchResults: {
    component_id: 'conductor-transfer-fixture',
    iterations: 1,
    warmup_iterations: 0,
    scenarios: [{ id: 'synthetic-transfer', metrics: { conductor_transfer_completed: 1 } }]
  }
}) + '\\n');
`);
  fs.chmodSync(fakeWpCodebox, 0o755);

  const benchHelper = path.join(root, 'bench-helper.sh');
  fs.writeFileSync(benchHelper, `#!/usr/bin/env bash
homeboy_write_empty_bench_results() {
  local component="$1"
  local iterations="$2"
  local results_file="$3"
  printf '{"component_id":"%s","iterations":%s,"scenarios":[]}\n' "$component" "$iterations" > "$results_file"
}
`);
  const preflightHelper = path.join(root, 'preflight-helper.sh');
  fs.writeFileSync(preflightHelper, `#!/usr/bin/env bash
homeboy_require_bash_version() { :; }
`);

  const successResult = spawnSync('bash', [path.join(extensionPath, 'scripts', 'bench', 'bench-runner.sh')], {
    cwd: componentPath,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOMEBOY_BENCH_RESULTS_FILE: path.join(root, 'results.json'),
      HOMEBOY_BENCH_ITERATIONS: '1',
      HOMEBOY_BENCH_WARMUP_ITERATIONS: '0',
      HOMEBOY_CAPTURE_RECIPE: captureFile,
      HOMEBOY_COMPONENT_ID: 'conductor-transfer-fixture',
      HOMEBOY_COMPONENT_PATH: componentPath,
      HOMEBOY_EXTENSION_PATH: extensionPath,
      HOMEBOY_RUNTIME_BASH_PREFLIGHT: preflightHelper,
      HOMEBOY_RUNTIME_BENCH_HELPER_SH: benchHelper,
      HOMEBOY_SETTINGS_JSON: JSON.stringify({ conductor_transfer_rigs: ['rigs/transfer.json'] }),
      HOMEBOY_WP_CODEBOX_BIN: fakeWpCodebox,
    },
  });

  assert.equal(successResult.status, 0, successResult.stderr || successResult.stdout);
  const recipe = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  const workloadsArg = recipe.workflow.steps[0].args.find((arg) => arg.startsWith('workloads-json='));
  assert.ok(workloadsArg, 'expected workloads-json arg');
  const workloads = JSON.parse(workloadsArg.slice('workloads-json='.length));
  assert.equal(workloads[0].metadata.adapter, 'homeboy-wordpress-conductor-transfer-rig');
  assert.equal(workloads[0].artifacts.transfer_report.kind, 'json');
  assert.equal(workloads[0].run.some((step) => step.label === 'Seed source runtime'), true);

  fs.writeFileSync(path.join(componentPath, 'rigs', 'private-source.json'), JSON.stringify({
    options: { auth_token: 'not allowed' },
  }, null, 2));
  fs.writeFileSync(path.join(componentPath, 'rigs', 'private-transfer.json'), JSON.stringify({
    id: 'private-transfer',
    source_manifest: 'private-source.json',
  }, null, 2));
  const failureArtifactsDir = path.join(root, 'failure-artifacts');
  const failureResult = spawnSync('bash', [path.join(extensionPath, 'scripts', 'bench', 'bench-runner.sh')], {
    cwd: componentPath,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOMEBOY_BENCH_RESULTS_FILE: path.join(root, 'failure-results.json'),
      HOMEBOY_BENCH_ITERATIONS: '1',
      HOMEBOY_BENCH_WARMUP_ITERATIONS: '0',
      HOMEBOY_CAPTURE_RECIPE: captureFile,
      HOMEBOY_COMPONENT_ID: 'conductor-transfer-fixture',
      HOMEBOY_COMPONENT_PATH: componentPath,
      HOMEBOY_EXTENSION_PATH: extensionPath,
      HOMEBOY_RUNTIME_BASH_PREFLIGHT: preflightHelper,
      HOMEBOY_RUNTIME_BENCH_HELPER_SH: benchHelper,
      HOMEBOY_SETTINGS_JSON: JSON.stringify({ conductor_transfer_rigs: ['rigs/private-transfer.json'] }),
      HOMEBOY_WP_CODEBOX_ARTIFACTS_DIR: failureArtifactsDir,
      HOMEBOY_WP_CODEBOX_BIN: fakeWpCodebox,
    },
  });

  assert.equal(failureResult.status, 0, failureResult.stderr || failureResult.stdout);
  const privateRecipe = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  const privateWorkloadsArg = privateRecipe.workflow.steps[0].args.find((arg) => arg.startsWith('workloads-json='));
  const privateWorkloads = JSON.parse(privateWorkloadsArg.slice('workloads-json='.length));
  assert.equal(privateWorkloads[0].metadata.source_seed.blocked.some((entry) => /sensitive key/.test(entry.reason)), true);

  console.log('conductor transfer workload smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
