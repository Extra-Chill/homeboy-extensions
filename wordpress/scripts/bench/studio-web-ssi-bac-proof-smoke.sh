#!/usr/bin/env bash
#
# Studio Web generated website artifact -> Static Site Importer -> BAC proof.
#
# Manual integration smoke. It uses the WordPress extension's WP Codebox bench
# path so the evidence is emitted as a standard Homeboy BenchResults envelope.
#
# Required local dependencies:
#   - wp-codebox CLI, or HOMEBOY_WP_CODEBOX_BIN
#   - /Users/chubes/Developer/static-site-importer
#   - /Users/chubes/Developer/block-artifact-compiler

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="${EXTENSION_PATH}/tests/fixtures/studio-web-ssi-bac-proof"
RESULTS_TMPFILE=$(mktemp "${TMPDIR:-/tmp}/studio-web-ssi-bac-proof-results.XXXXXX")
SETTINGS_TMPFILE=$(mktemp "${TMPDIR:-/tmp}/studio-web-ssi-bac-proof-settings.XXXXXX")
ARTIFACTS_DIR=$(mktemp -d "${TMPDIR:-/tmp}/studio-web-ssi-bac-proof-artifacts.XXXXXX")

if [ -z "${HOMEBOY_WP_CODEBOX_BIN:-}" ] && ! command -v wp-codebox >/dev/null 2>&1; then
    echo "ERROR: wp-codebox not installed. Set HOMEBOY_WP_CODEBOX_BIN or run wordpress/scripts/build/setup.sh" >&2
    exit 1
fi

for dependency in /Users/chubes/Developer/static-site-importer /Users/chubes/Developer/block-artifact-compiler; do
    if [ ! -d "$dependency" ]; then
        echo "ERROR: dependency checkout not found: $dependency" >&2
        exit 1
    fi
done

jq -n \
    --arg artifacts "$ARTIFACTS_DIR" \
    '{
        validation_dependencies: ["/Users/chubes/Developer/static-site-importer", "/Users/chubes/Developer/block-artifact-compiler"],
        wp_codebox_artifacts_dir: $artifacts,
        bench_warmup_iterations: 0
    }' > "$SETTINGS_TMPFILE"

HOMEBOY_BENCH_RESULTS_FILE="$RESULTS_TMPFILE" \
HOMEBOY_BENCH_ITERATIONS=1 \
HOMEBOY_COMPONENT_ID=studio-web-ssi-bac-proof \
HOMEBOY_COMPONENT_PATH="$FIXTURE_DIR" \
HOMEBOY_EXTENSION_PATH="$EXTENSION_PATH" \
HOMEBOY_SETTINGS_JSON="$(<"$SETTINGS_TMPFILE")" \
    bash "${SCRIPT_DIR}/bench-runner.sh"

jq -e '
    .component_id == "studio-web-ssi-bac-proof"
    and (.scenarios | length) == 1
    and .scenarios[0].id == "studio-web-ssi-bac"
    and .scenarios[0].metrics.proof_success_mean == 1
    and .scenarios[0].metadata.import_mode == "static-site-importer/import-theme"
    and .scenarios[0].metadata.compiler_summary.schema == "chubes4/block-artifact-compiler-result/v1"
    and (.scenarios[0].metadata.compiler_summary.status | test("^success"))
' "$RESULTS_TMPFILE" >/dev/null

echo "Studio Web SSI/BAC proof passed"
echo "Results: $RESULTS_TMPFILE"
echo "WP Codebox artifacts: $ARTIFACTS_DIR"
