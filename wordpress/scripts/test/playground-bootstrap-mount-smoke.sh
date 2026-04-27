#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)"

assert_contains() {
    local file="$1"
    local needle="$2"
    if ! grep -Fq -- "$needle" "$file"; then
        echo "FAIL: expected $file to contain: $needle" >&2
        exit 1
    fi
}

TEST_RUNNER="$SCRIPT_DIR/test-runner-playground.sh"
BENCH_RUNNER="$EXTENSION_PATH/scripts/bench/bench-runner-playground.sh"

for runner in "$TEST_RUNNER" "$BENCH_RUNNER"; do
    assert_contains "$runner" 'PLAYGROUND_BOOTSTRAP_PHP="${EXTENSION_PATH}/scripts/lib/playground-bootstrap.php"'
    assert_contains "$runner" 'This is a Homeboy WordPress extension installation/update problem'
    assert_contains "$runner" 'exit 2'
    assert_contains "$runner" ':/homeboy-extension/scripts/lib/playground-bootstrap.php'
done

assert_contains "$TEST_RUNNER" 'FAILED_STEP="Playground PHP crash (before runner took control)"'
assert_contains "$BENCH_RUNNER" 'FAILED_STEP="Playground PHP crash (before bench runner took control)"'

echo "PASS: Playground bootstrap mount and infrastructure exit contract is pinned."
