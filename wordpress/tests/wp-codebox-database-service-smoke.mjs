import { strict as assert } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const extension = path.resolve(import.meta.dirname, '..');
const runner = path.join(extension, 'scripts/test/test-runner-wp-codebox.sh');
const root = await mkdtemp(path.join(os.tmpdir(), 'wp-codebox-database-service-'));
const component = path.join(root, 'plugin');
const cli = path.join(root, 'wp-codebox');
await mkdir(component, { recursive: true });
await writeFile(path.join(component, 'plugin.php'), '<?php\n/**\n * Plugin Name: Provider Test\n */\n');
await writeFile(cli, `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args[0] === 'recipe' && args[1] === 'build') {
  const options = JSON.parse(await readFile(args[args.indexOf('--options') + 1], 'utf8'));
  await appendFile(process.env.OBSERVED, JSON.stringify({ phase: 'build', options }) + '\\n');
  if (options.services?.[0]?.configuration?.provider === 'unregistered') {
    process.stderr.write('Unsupported managed runtime service provider: unregistered\\n');
    process.exit(2);
  }
  const recipe = { schema: 'wp-codebox/workspace-recipe/v1', inputs: { services: options.services } };
  await writeFile(args[args.indexOf('--output') + 1], JSON.stringify(recipe));
  process.exit(0);
}
if (args[0] === 'recipe-run') {
  const recipe = JSON.parse(await readFile(args[args.indexOf('--recipe') + 1], 'utf8'));
  await appendFile(process.env.OBSERVED, JSON.stringify({ phase: 'run', recipe }) + '\\n');
  const configuration = recipe.inputs.services?.[0]?.configuration || {};
  for (const name of [configuration.hostEnv, configuration.portEnv, configuration.usernameEnv, configuration.passwordEnv].filter(Boolean)) {
    process.stdout.write('provider stdout ' + process.env[name] + '\\n');
    process.stderr.write('provider stderr ' + process.env[name] + '\\n');
  }
}
`);
await chmod(cli, 0o755);

let scenario = 0;
function invoke(settings, env = {}) {
  scenario += 1;
  const observed = path.join(root, `observed-${scenario}.jsonl`);
  const result = spawnSync(runner, [], {
    env: {
      ...process.env,
      HOMEBOY_COMPONENT_PATH: component,
      COMPONENT_ID: 'provider-test',
      HOMEBOY_WP_CODEBOX_BIN: cli,
      HOMEBOY_SETTINGS_JSON: JSON.stringify(settings),
      OBSERVED: observed,
      ...env,
    },
    encoding: 'utf8',
  });
  return { result, observed };
}

async function observations(file) {
  try {
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function expectPreflightFailure(settings, pattern, env = {}) {
  const invocation = invoke(settings, env);
  assert.notEqual(invocation.result.status, 0);
  assert.match(invocation.result.stderr, pattern);
  return invocation;
}

try {
  const defaultInvocation = invoke({ database_type: 'mysql', wp_codebox_multisite: true });
  assert.equal(defaultInvocation.result.status, 0, defaultInvocation.result.stderr);
  const defaultBuild = (await observations(defaultInvocation.observed))[0].options;
  assert.equal('services' in defaultBuild, false, 'omitted provider preserves WP Codebox service defaults');
  assert.equal('secretEnv' in defaultBuild, false, 'omitted provider adds no secret declarations');
  assert.equal(defaultBuild.databaseType, 'mysql');
  assert.equal(defaultBuild.multisite, true);

  const secretValues = {
    PROVIDER_ADMIN_HOST: 'database.internal.example',
    PROVIDER_ADMIN_PORT: '3306',
    PROVIDER_ADMIN_USER: 'temporary-database-admin',
    PROVIDER_ADMIN_PASSWORD: 'do-not-persist-this-password',
  };
  const configured = {
    database_type: 'mysql',
    wp_codebox_multisite: true,
    wp_codebox_database_service: {
      provider: 'external',
      secret_env: {
        host: 'PROVIDER_ADMIN_HOST',
        port: 'PROVIDER_ADMIN_PORT',
        username: 'PROVIDER_ADMIN_USER',
        password: 'PROVIDER_ADMIN_PASSWORD',
      },
    },
  };
  const externalInvocation = invoke(configured, secretValues);
  assert.equal(externalInvocation.result.status, 0, externalInvocation.result.stderr);
  const externalObservations = await observations(externalInvocation.observed);
  const options = externalObservations[0].options;
  assert.equal(options.databaseType, 'mysql');
  assert.equal(options.multisite, true, 'external MySQL remains compatible with multisite PHPUnit');
  assert.equal('secretEnv' in options, false, 'administrative credentials are not forwarded into the sandbox runtime');
  assert.deepEqual(options.services, [{
    id: 'wordpress-database',
    kind: 'mysql',
    configuration: {
      provider: 'external',
      hostEnv: 'PROVIDER_ADMIN_HOST',
      portEnv: 'PROVIDER_ADMIN_PORT',
      usernameEnv: 'PROVIDER_ADMIN_USER',
      passwordEnv: 'PROVIDER_ADMIN_PASSWORD',
    },
    outputs: { host: 'DB_HOST', port: 'DB_PORT', username: 'DB_USER', password: 'DB_PASSWORD', database: 'DB_NAME' },
  }]);
  const serializedOptions = JSON.stringify(options);
  const serializedRecipe = JSON.stringify(externalObservations[1].recipe);
  for (const value of Object.values(secretValues)) {
    assert.equal(serializedOptions.includes(value), false, 'builder options omit provider credential values');
    assert.equal(serializedRecipe.includes(value), false, 'generated recipe omits provider credential values');
    assert.equal(externalInvocation.result.stdout.includes(value), false, 'Homeboy stdout omits provider credential values');
    assert.equal(externalInvocation.result.stderr.includes(value), false, 'Homeboy stderr omits provider credential values');
  }
  assert.match(externalInvocation.result.stdout, /provider stdout \[REDACTED\]/);
  assert.match(externalInvocation.result.stderr, /provider stderr \[REDACTED\]/);

  const missingProvider = expectPreflightFailure({
    database_type: 'mysql',
    wp_codebox_database_service: { secret_env: { host: 'PROVIDER_ADMIN_HOST', username: 'PROVIDER_ADMIN_USER', password: 'PROVIDER_ADMIN_PASSWORD' } },
  }, /provider must name a registered WP Codebox provider/, secretValues);
  assert.deepEqual(await observations(missingProvider.observed), [], 'missing provider fails before WP Codebox execution');

  expectPreflightFailure({
    database_type: 'mysql',
    wp_codebox_database_service: { provider: 'external' },
  }, /secret_env must contain provider secret environment references/);
  expectPreflightFailure({
    database_type: 'mysql',
    wp_codebox_database_service: { provider: 'external', secret_env: { host: 'PROVIDER_ADMIN_HOST' } },
  }, /missing required references: username, password/, secretValues);
  expectPreflightFailure({
    database_type: 'mysql',
    wp_codebox_database_service: { provider: 'external', secret_env: { host: 'MISSING_PROVIDER_HOST', username: 'PROVIDER_ADMIN_USER', password: 'PROVIDER_ADMIN_PASSWORD' } },
  }, /secret environment variable is unavailable: MISSING_PROVIDER_HOST/, secretValues);
  expectPreflightFailure({
    database_type: 'mysql',
    wp_codebox_database_service: { provider: 'external', secret_env: ['PROVIDER_ADMIN_HOST'] },
  }, /secret_env must contain provider secret environment references/);
  expectPreflightFailure({
    database_type: 'mysql',
    wp_codebox_database_service: { provider: 'external', secret_env: { host: 'PROVIDER_ADMIN_HOST', username: 'PROVIDER_ADMIN_USER', password: 'PROVIDER_ADMIN_PASSWORD' }, password: 'plaintext' },
  }, /unsupported fields: password/, secretValues);
  expectPreflightFailure({
    database_type: 'sqlite',
    wp_codebox_database_service: { provider: 'external', secret_env: { host: 'PROVIDER_ADMIN_HOST', username: 'PROVIDER_ADMIN_USER', password: 'PROVIDER_ADMIN_PASSWORD' } },
  }, /requires database_type=mysql/, secretValues);

  const unsupported = expectPreflightFailure({
    database_type: 'mysql',
    wp_codebox_database_service: { provider: 'unregistered', secret_env: { host: 'PROVIDER_ADMIN_HOST', username: 'PROVIDER_ADMIN_USER', password: 'PROVIDER_ADMIN_PASSWORD' } },
  }, /Unsupported managed runtime service provider: unregistered/, secretValues);
  assert.deepEqual((await observations(unsupported.observed)).map(({ phase }) => phase), ['build'], 'unsupported providers fail before workload execution');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('WP Codebox database service smoke passed.');
