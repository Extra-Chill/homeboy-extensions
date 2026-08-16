#!/usr/bin/env bash
# Prove the installed extension layout can load shared agent-runtime files.
#
# `agent-runtimes` is a shared asset: Homeboy installs it at
# <homeboy>/agent-runtimes, a sibling of <homeboy>/extensions, while a monorepo
# checkout keeps it one level closer to the extension. A linked dev install
# hides the difference because Node and `pwd -P` resolve a symlinked extension
# back to the checkout, so this fixture COPIES the extension scripts — that is
# the shape a fresh CI runner has, and the shape that produced four identical
# MODULE_NOT_FOUND shard bootstrap failures in #12585.
set -euo pipefail

WORDPRESS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY_ROOT="$(cd "${WORDPRESS_ROOT}/.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

HOMEBOY_ROOT="${FIXTURE_ROOT}/config/homeboy"
EXTENSION_DIR="${HOMEBOY_ROOT}/extensions/wordpress"
mkdir -p "${EXTENSION_DIR}" "${HOMEBOY_ROOT}/extensions/scripts"
cp -R "${WORDPRESS_ROOT}/scripts" "${EXTENSION_DIR}/scripts"
ln -s "${REPOSITORY_ROOT}/agent-runtimes" "${HOMEBOY_ROOT}/agent-runtimes"
ln -s "${REPOSITORY_ROOT}/scripts/lib" "${HOMEBOY_ROOT}/extensions/scripts/lib"

# The WordPress wrapper must reach the shared opencode runtime executor.
executor_output="$(node "${EXTENSION_DIR}/scripts/agent/homeboy-opencode-agent-task-executor.cjs" </dev/null 2>&1)"
case "$executor_output" in
    *'"provider": "opencode.agent-task-executor"'*) ;;
    *)
        echo "Expected installed opencode executor wrapper to load the shared runtime, got: ${executor_output}" >&2
        exit 1
        ;;
esac

# The PHPUnit adapter resolves its runtime-selection module before it validates
# its own environment, so reaching the HOMEBOY_COMPONENT_PATH error is proof the
# require succeeded.
set +e
adapter_output="$(HOMEBOY_SETTINGS_JSON='{}' node "${EXTENSION_DIR}/scripts/test/wp-codebox-phpunit-adapter.mjs" 2>&1)"
set -e
case "$adapter_output" in
    *"Cannot find module"*)
        echo "Installed PHPUnit adapter failed to resolve a module: ${adapter_output}" >&2
        exit 1
        ;;
esac
case "$adapter_output" in
    *HOMEBOY_COMPONENT_PATH*) ;;
    *)
        echo "Expected installed PHPUnit adapter to reach its environment validation, got: ${adapter_output}" >&2
        exit 1
        ;;
esac

# The result parser sources the WP Codebox adapters from the shared tree; when
# it cannot, wp-codebox-json silently degrades and a shard reports no counts.
mkdir -p "${FIXTURE_ROOT}/artifacts/files"
cat > "${FIXTURE_ROOT}/artifacts/files/test-results.json" <<'JSON'
{"schema":"wp-codebox/test-results/v1","summary":{"total":3,"passed":2,"failed":1,"skipped":0}}
JSON
cat > "${FIXTURE_ROOT}/write-test-results.sh" <<'EOF'
homeboy_write_test_results() {
    printf 'total=%s passed=%s failed=%s skipped=%s\n' "$1" "$2" "$3" "$4"
}
EOF
HOMEBOY_RUNTIME_WRITE_TEST_RESULTS="${FIXTURE_ROOT}/write-test-results.sh" \
HOMEBOY_EXTENSION_PATH="${EXTENSION_DIR}" \
    bash "${EXTENSION_DIR}/scripts/test/parse-test-results.sh" \
        "${FIXTURE_ROOT}/artifacts" wp-codebox-json >"${FIXTURE_ROOT}/parse-output.txt" 2>&1
if ! grep -q 'total=3 passed=2 failed=1 skipped=0' "${FIXTURE_ROOT}/parse-output.txt"; then
    echo "Expected installed result parser to report WP Codebox counts, got: $(cat "${FIXTURE_ROOT}/parse-output.txt")" >&2
    exit 1
fi

# An incomplete install must name what is missing instead of emitting a bare
# MODULE_NOT_FOUND stack that says nothing about shared-asset packaging.
rm "${HOMEBOY_ROOT}/agent-runtimes"
set +e
missing_output="$(HOMEBOY_SETTINGS_JSON='{}' node "${EXTENSION_DIR}/scripts/test/wp-codebox-phpunit-adapter.mjs" 2>&1)"
missing_status=$?
set -e
[ "$missing_status" -ne 0 ] || { echo "Expected missing shared runtime to fail the adapter" >&2; exit 1; }
case "$missing_output" in
    *"could not resolve shared agent runtime file"*"${HOMEBOY_ROOT}/agent-runtimes"*"homeboy extension install wordpress"*) ;;
    *)
        echo "Expected an actionable missing-runtime diagnostic, got: ${missing_output}" >&2
        exit 1
        ;;
esac

printf '%s\n' 'installed agent runtime resolution smoke passed'
