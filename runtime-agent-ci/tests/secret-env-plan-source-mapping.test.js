'use strict';

const assert = require('node:assert/strict');
const {
  buildSecretEnvPlan,
  buildSecretEnvSourceMapping,
} = require('../lib/runtime-contracts.cjs');

const sourceMapping = buildSecretEnvSourceMapping({
  githubTokenEnv: 'HOMEBOY_GITHUB_APP_TOKEN',
  githubRepositoryTokenEnv: 'GITHUB_TOKEN',
  providerCanonicalSecretEnvNames: ['OPENAI_API_KEY'],
  providerCredentialSourceEnvNames: ['PROVIDER_SECRET_0'],
});

assert.deepEqual(sourceMapping, {
  HOMEBOY_GITHUB_APP_TOKEN: ['HOMEBOY_GITHUB_APP_TOKEN', 'GITHUB_TOKEN'],
  OPENAI_API_KEY: ['OPENAI_API_KEY', 'PROVIDER_SECRET_0'],
});

const plan = buildSecretEnvPlan({
  secretEnv: ['OPENAI_API_KEY', 'PROVIDER_SECRET_0', 'HOMEBOY_GITHUB_APP_TOKEN', 'GITHUB_TOKEN'],
  runtimeEnv: { PUBLIC_FLAG: '1', IGNORED_NON_STRING: 2 },
  providerSecretEnvMapping: { default: 'PROVIDER_SECRET_0' },
  secretEnvSourceMapping: sourceMapping,
});

assert.equal(plan.schema, 'homeboy/secret-env-plan/v1');
assert.deepEqual(plan.public_env, { PUBLIC_FLAG: '1' });
assert.equal(Object.hasOwn(plan, 'secret_env_fallbacks'), false);
assert.deepEqual(plan.requirements.find((requirement) => requirement.name === 'OPENAI_API_KEY'), {
  name: 'OPENAI_API_KEY',
  required: true,
  source_env_names: ['OPENAI_API_KEY', 'PROVIDER_SECRET_0'],
});
assert.deepEqual(plan.requirements.find((requirement) => requirement.name === 'HOMEBOY_GITHUB_APP_TOKEN'), {
  name: 'HOMEBOY_GITHUB_APP_TOKEN',
  required: true,
  source_env_names: ['HOMEBOY_GITHUB_APP_TOKEN', 'GITHUB_TOKEN'],
});

process.stdout.write('SecretEnvPlan source env mapping checks passed\n');
