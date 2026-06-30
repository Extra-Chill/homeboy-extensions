'use strict';

const SECRET_ENV_PLAN_SCHEMA = 'homeboy/secret-env-plan/v1';
const ARTIFACT_PATHS_SCHEMA = 'homeboy/runtime-agent-artifact-paths/v1';
const ARTIFACT_MANIFEST_SCHEMA = 'homeboy/artifact-manifest/v1';
const ARTIFACT_MANIFEST_FILE = 'homeboy-artifact-manifest.json';
const RUNNER_ARTIFACT_MANIFEST_REF_SCHEMA = 'homeboy/runner-artifact-manifest-ref/v1';
const CANONICAL_RUN_ARTIFACT_FILES = Object.freeze({
  events: 'events.json',
  status: 'status.json',
  results: 'results.json',
  outcome: 'outcome.json',
  fanout_run: 'fanout-run.json',
  loop_result: 'loop-result.json',
  loop_policy: 'loop-policy.json',
});

// Local adapter seam for Homeboy core's SecretEnvPlan shape. Homeboy does not
// expose this as a JS library yet, so keep this mirror intentionally small.
function buildSecretEnvPlan({ secretEnv = [], runtimeEnv = {}, providerSecretEnvMapping = {}, secretEnvSourceMapping = {} } = {}) {
  const secretEnvNames = uniqueStrings(secretEnv);
  return {
    schema: SECRET_ENV_PLAN_SCHEMA,
    public_env: Object.fromEntries(Object.entries(runtimeEnv).filter(([, value]) => typeof value === 'string')),
    secret_env_names: secretEnvNames,
    requirements: secretEnvNames.map((name) => {
      const sourceEnvNames = normalizeSourceEnvNames(secretEnvSourceMapping[name]);
      return {
        name,
        required: true,
        ...(sourceEnvNames.length > 0 ? { source_env_names: sourceEnvNames } : {}),
      };
    }),
    env_name_mapping: Object.fromEntries(Object.entries({
      provider_secret_env: Object.values(providerSecretEnvMapping).filter((value) => typeof value === 'string' && value.length > 0),
    }).filter(([, names]) => names.length > 0)),
    inheritance: {
      require_declaration: true,
      allowed_env_names: ['HOMEBOY_AGENT_RUNTIME_SECRET_ENV'],
    },
  };
}

// Build SecretEnvRequirement.source_env_names candidates. The target name stays
// first so an explicitly provided canonical secret wins over mapped sources.
function buildSecretEnvSourceMapping({
  githubTokenEnv,
  githubRepositoryTokenEnv,
  providerCanonicalSecretEnvNames = [],
  providerCredentialSourceEnvNames = [],
} = {}) {
  const sourceMapping = {};
  if (githubTokenEnv && githubRepositoryTokenEnv && githubTokenEnv !== githubRepositoryTokenEnv) {
    sourceMapping[githubTokenEnv] = [githubTokenEnv, githubRepositoryTokenEnv];
  }
  if (providerCredentialSourceEnvNames.length > 0) {
    for (const canonical of providerCanonicalSecretEnvNames) {
      const sources = providerCredentialSourceEnvNames.filter((name) => name !== canonical);
      if (sources.length > 0) {
        sourceMapping[canonical] = normalizeSourceEnvNames([...(sourceMapping[canonical] || [canonical]), ...sources]);
      }
    }
  }
  return sourceMapping;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0))).sort();
}

function normalizeSourceEnvNames(values) {
  const seen = new Set();
  const names = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value === 'string' && value.length > 0 && !seen.has(value)) {
      seen.add(value);
      names.push(value);
    }
  }
  return names;
}

module.exports = {
  ARTIFACT_MANIFEST_FILE,
  ARTIFACT_MANIFEST_SCHEMA,
  ARTIFACT_PATHS_SCHEMA,
  CANONICAL_RUN_ARTIFACT_FILES,
  RUNNER_ARTIFACT_MANIFEST_REF_SCHEMA,
  SECRET_ENV_PLAN_SCHEMA,
  buildSecretEnvPlan,
  buildSecretEnvSourceMapping,
};
