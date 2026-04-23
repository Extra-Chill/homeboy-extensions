#!/usr/bin/env bash
set -euo pipefail

# Playground test runner for WordPress Homeboy extension.
#
# Boots a WordPress Playground instance (PHP-WASM + embedded SQLite),
# mounts the component under test, runs PHPUnit inside it, and emits
# the same JSON result shape as test-runner.sh.
#
# This is the "playground" backend — opt-in, not the default.
# The host backend (test-runner.sh) remains the default.
#
# HOW IT WORKS:
#
# 1. Generates a PHP wrapper script that:
#    - Generates wp-tests-config.php inside the wp-phpunit VFS
#    - Sets env vars (WP_TESTS_DIR, ABSPATH, HOMEBOY_*)
#    - Loads the wp-phpunit bootstrap with WP_TESTS_SKIP_INSTALL=1
#      (Playground's PHP-WASM cannot spawn subprocesses via system(),
#       so the WP install step is skipped)
#    - Discovers and runs test files via PHPUnit's programmatic API
#
# 2. Mounts host directories into Playground's VFS:
#    - Plugin under test → /wordpress/wp-content/plugins/<slug>
#    - Dependencies      → /wordpress/wp-content/plugins/<dep>
#    - Extension dir     → /homeboy-extension
#    - Custom db.php     → /wordpress/wp-content/db.php (if present)
#
# 3. Runs the wrapper via `wp-playground-cli php`
#
# KNOWN GAPS (Phase 1):
#   - DB tables are not created (WP_TESTS_SKIP_INSTALL=1). Tests that
#     use WP_UnitTestCase factory methods (user/post creation) will fail
#     with "no such table". Future work: in-process WP install.
#   - PHPUnit stdout is not forwarded by the Playground CLI's php
#     subcommand. Results are captured via a host-mounted log file.
#   - WP version is pinned to match wp-phpunit package (6.9.x).
#
# See TEST_INFRASTRUCTURE_PLAN.md §17 for the full gap analysis.

FAILED_STEP=""
FAILURE_OUTPUT=""
FAILURE_REPLAY_MODE="full"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_PATH="${HOMEBOY_EXTENSION_PATH:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
RUNNER_STEPS_HELPER="${HOMEBOY_RUNTIME_RUNNER_STEPS:-${SCRIPT_DIR}/../lib/runner-steps.sh}"
DEPENDENCY_HELPER="${HOMEBOY_WORDPRESS_DEPENDENCY_HELPER:-${SCRIPT_DIR}/../lib/validation-dependencies.sh}"
PHP_PREFLIGHT_HELPER="${SCRIPT_DIR}/../lib/php-preflight.sh"
# shellcheck source=../lib/runner-steps.sh
if [ -f "$RUNNER_STEPS_HELPER" ]; then
    source "$RUNNER_STEPS_HELPER"
fi
# shellcheck source=../lib/validation-dependencies.sh
if [ -f "$DEPENDENCY_HELPER" ]; then
    source "$DEPENDENCY_HELPER"
fi
# shellcheck source=../lib/php-preflight.sh
if [ -f "$PHP_PREFLIGHT_HELPER" ]; then
    source "$PHP_PREFLIGHT_HELPER"
fi

print_failure_summary() {
    if [ -n "$FAILED_STEP" ]; then
        echo ""
        echo "============================================"
        echo "BUILD FAILED: $FAILED_STEP"
        echo "============================================"
        if [ "$FAILURE_REPLAY_MODE" = "none" ]; then
            echo ""
            echo "See PHPUnit output above (not replayed)."
        elif [ -n "$FAILURE_OUTPUT" ]; then
            echo ""
            echo "Error details:"
            echo "$FAILURE_OUTPUT"
        fi
    fi
}
trap print_failure_summary EXIT

SETTINGS_JSON="${HOMEBOY_SETTINGS_JSON:-}"

if [ -n "${HOMEBOY_COMPONENT_PATH:-}" ]; then
    PLUGIN_PATH="${HOMEBOY_COMPONENT_PATH}"
    COMPONENT_ID="${HOMEBOY_COMPONENT_ID:-}"
elif [ -n "${HOMEBOY_PROJECT_PATH:-}" ]; then
    PLUGIN_PATH="${HOMEBOY_PROJECT_PATH}"
    COMPONENT_ID=""
else
    PLUGIN_PATH="$(pwd)"
    COMPONENT_ID="$(basename "$PLUGIN_PATH")"
fi

if [ "${HOMEBOY_DEBUG:-}" = "1" ]; then
    echo "DEBUG: [playground] Extension path: $EXTENSION_PATH"
    echo "DEBUG: [playground] Plugin path: $PLUGIN_PATH"
    echo "DEBUG: [playground] Component ID: ${COMPONENT_ID:-none}"
fi

PLAYGROUND_CLI="${EXTENSION_PATH}/node_modules/.bin/wp-playground-cli"
if [ ! -f "$PLAYGROUND_CLI" ]; then
    echo "Error: @wp-playground/cli not found at $PLAYGROUND_CLI"
    echo ""
    echo "Install it with: cd ${EXTENSION_PATH} && npm install"
    echo "Or switch backends: homeboy component set <id> test_backend host"
    FAILED_STEP="Playground CLI setup"
    exit 1
fi

TEST_DIR="${PLUGIN_PATH}/tests"
if [ ! -d "$TEST_DIR" ]; then
    echo ""
    echo "⚠ Warning: No tests directory found at ${TEST_DIR}"
    echo "  Skipping PHPUnit tests."
    echo ""
    exit 0
fi

if type homeboy_php_preflight &>/dev/null; then
    homeboy_php_preflight "$PLUGIN_PATH"
fi

if [ -n "${COMPONENT_ID:-}" ]; then
    export HOMEBOY_COMPONENT_ID="$COMPONENT_ID"
    export HOMEBOY_COMPONENT_PATH="$PLUGIN_PATH"
    export HOMEBOY_PLUGIN_PATH="$PLUGIN_PATH"
else
    export HOMEBOY_PROJECT_PATH="$PLUGIN_PATH"
    export HOMEBOY_PLUGIN_PATH="$PLUGIN_PATH"
fi

if type homeboy_export_validation_dependency_paths &>/dev/null; then
    homeboy_export_validation_dependency_paths "$PLUGIN_PATH"
fi
DEPENDENCY_PATHS="${HOMEBOY_WORDPRESS_DEPENDENCY_PATHS:-}"

PLUGIN_SLUG="$(basename "$PLUGIN_PATH")"
MOUNT_ARGS=()

MOUNT_ARGS+=("--mount" "${PLUGIN_PATH}:/wordpress/wp-content/plugins/${PLUGIN_SLUG}")

if [ -n "$DEPENDENCY_PATHS" ]; then
    while IFS= read -r dep_path; do
        [ -z "$dep_path" ] && continue
        dep_slug="$(basename "$dep_path")"
        MOUNT_ARGS+=("--mount" "${dep_path}:/wordpress/wp-content/plugins/${dep_slug}")
    done <<< "$DEPENDENCY_PATHS"
fi

PLUGIN_DB_PHP="${PLUGIN_PATH}/db.php"
if [ -f "$PLUGIN_DB_PHP" ]; then
    MOUNT_ARGS+=("--mount" "${PLUGIN_DB_PHP}:/wordpress/wp-content/db.php")
fi

MOUNT_ARGS+=("--mount" "${EXTENSION_PATH}:/homeboy-extension")

PLAYGROUND_DEP_MOUNTS=""
if [ -n "$DEPENDENCY_PATHS" ]; then
    while IFS= read -r dep_path; do
        [ -z "$dep_path" ] && continue
        dep_slug="$(basename "$dep_path")"
        if [ -n "$PLAYGROUND_DEP_MOUNTS" ]; then
            PLAYGROUND_DEP_MOUNTS+="\\n"
        fi
        PLAYGROUND_DEP_MOUNTS+="/wordpress/wp-content/plugins/${dep_slug}"
    done <<< "$DEPENDENCY_PATHS"
fi

RESULT_FILE="${PLUGIN_PATH}/.pg-test-result.txt"
rm -f "$RESULT_FILE"

WRAPPER_SCRIPT=$(cat <<PHPWRAPPER
<?php
error_reporting(E_ALL & ~E_WARNING & ~E_NOTICE);

\$out = '/wordpress/wp-content/plugins/${PLUGIN_SLUG}/.pg-test-result.txt';
function log_msg(\$msg) { global \$out; file_put_contents(\$out, \$msg . "\\n", FILE_APPEND); }
register_shutdown_function(function() {
    global \$out;
    \$error = error_get_last();
    if (\$error && \$error['type'] === E_ERROR) {
        file_put_contents(\$out, "FATAL: {\$error['message']}\\n", FILE_APPEND);
    }
});

\$tests_dir = '/homeboy-extension/vendor/wp-phpunit/wp-phpunit';
\$plugin_path = '/wordpress/wp-content/plugins/${PLUGIN_SLUG}';

file_put_contents("\$tests_dir/wp-tests-config.php", <<<'CONFIG'
<?php
\\\$table_prefix = 'wptests_';
define('DB_NAME', ':memory:');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', 'localhost');
define('DB_CHARSET', 'utf8');
define('WP_TESTS_DOMAIN', 'example.org');
define('WP_TESTS_EMAIL', 'admin@example.org');
define('WP_TESTS_TITLE', 'Test Blog');
define('WP_PHP_BINARY', 'php');
define('ABSPATH', '/wordpress/');
define('FS_CHMOD_FILE', 0644);
define('FS_CHMOD_DIR', 0755);
define('FS_METHOD', 'direct');
define('WP_INSTALLING', true);
CONFIG
);

require_once '/homeboy-extension/vendor/autoload.php';
log_msg("BOOT OK");

putenv("WP_TESTS_DIR=\$tests_dir");
putenv("ABSPATH=/wordpress");
putenv("WP_TESTS_SKIP_INSTALL=1");
putenv("HOMEBOY_COMPONENT_ID=${COMPONENT_ID}");
putenv("HOMEBOY_COMPONENT_PATH=\$plugin_path");
putenv("HOMEBOY_PLUGIN_PATH=\$plugin_path");
putenv("HOMEBOY_WORDPRESS_DEPENDENCY_PATHS=${PLAYGROUND_DEP_MOUNTS}");

require_once "\$tests_dir/includes/functions.php";

\\\$component_file = null;
\\\$files = glob("\\\$plugin_path/*.php");
foreach (\\\$files as \\\$f) {
    if (strpos(file_get_contents(\\\$f), 'Plugin Name:') !== false) {
        \\\$component_file = \\\$f;
        break;
    }
}
if (\\\$component_file) {
    tests_add_filter('muplugins_loaded', function() use (\\\$component_file) {
        require_once \\\$component_file;
    });
}

log_msg("LOADING BOOTSTRAP");
require_once "\$tests_dir/includes/bootstrap.php";
log_msg("BOOTSTRAP OK");

wp_installing(false);
while (ob_get_level() > 0) @ob_end_clean();

log_msg("DISCOVERING TESTS");
\\\$test_dir = "\$plugin_path/tests";
\\\$test_files = array_merge(
    glob("\\\$test_dir/test-*.php") ?: [],
    glob("\\\$test_dir/*Test.php") ?: []
);
if (empty(\\\$test_files)) {
    log_msg("NO TEST FILES FOUND");
    exit(1);
}

\\\$suite = new PHPUnit\\Framework\\TestSuite('Playground Tests');
foreach (\\\$test_files as \\\$tf) {
    require_once \\\$tf;
    \\\$class_name = basename(\\\$tf, '.php');
    if (class_exists(\\\$class_name)) {
        \\\$suite->addTestSuite(\\\$class_name);
    }
}

log_msg("RUNNING " . count(\\\$test_files) . " TEST FILES");
\\\$runner = new PHPUnit\\TextUI\\TestRunner();
\\\$result = \\\$runner->run(\\\$suite, ['colors' => 'never', 'testdox' => true, 'verbose' => false]);
log_msg(\\\$result->wasSuccessful() ? "ALL TESTS PASSED" : "SOME TESTS FAILED");
log_msg("TESTS: " . \\\$result->count() . " FAILURES: " . count(\\\$result->failures()) . " ERRORS: " . count(\\\$result->errors()));
exit(\\\$result->wasSuccessful() ? 0 : 1);
PHPWRAPPER
)

WRAPPER_TMPFILE=$(mktemp --suffix=.php)
echo "$WRAPPER_SCRIPT" > "$WRAPPER_TMPFILE"

echo "Running PHPUnit tests via WordPress Playground..."
echo "  Plugin: ${PLUGIN_SLUG} (${PLUGIN_PATH})"
echo "  Backend: playground (PHP-WASM + SQLite)"

if [ "${HOMEBOY_DEBUG:-}" = "1" ]; then
    echo "  Wrapper: $WRAPPER_TMPFILE"
    echo "  Mount args: ${MOUNT_ARGS[*]}"
fi

set +e
"$PLAYGROUND_CLI" php \
    "${MOUNT_ARGS[@]}" \
    "--mount" "${WRAPPER_TMPFILE}:/runner.php" \
    --wp=6.9 \
    --verbosity=normal \
    -- /runner.php \
    2>&1
playground_exit=$?
set -e

rm -f "$WRAPPER_TMPFILE"

PHPUNIT_OUTPUT=""
if [ -f "$RESULT_FILE" ]; then
    PHPUNIT_OUTPUT=$(cat "$RESULT_FILE")
    echo ""
    echo "--- Playground test results ---"
    echo "$PHPUNIT_OUTPUT"
    echo ""
fi

PARSE_RESULTS="${EXTENSION_PATH}/scripts/test/parse-test-results.sh"
if [ -n "${HOMEBOY_TEST_RESULTS_FILE:-}" ] && [ -f "$PARSE_RESULTS" ] && [ -n "$PHPUNIT_OUTPUT" ]; then
    echo "$PHPUNIT_OUTPUT" | bash "$PARSE_RESULTS" || true
fi

if [ $playground_exit -ne 0 ]; then
    if echo "$PHPUNIT_OUTPUT" | grep -q "SOME TESTS FAILED"; then
        FAILED_STEP="PHPUnit tests (playground backend)"
        FAILURE_REPLAY_MODE="none"
        rm -f "$RESULT_FILE"
        exit $playground_exit
    elif echo "$PHPUNIT_OUTPUT" | grep -q "FATAL:"; then
        FAILED_STEP="Playground bootstrap"
        FAILURE_OUTPUT=$(echo "$PHPUNIT_OUTPUT" | grep "FATAL:")
        rm -f "$RESULT_FILE"
        exit $playground_exit
    else
        echo ""
        echo "============================================"
        echo "NOTE: Playground exited with code $playground_exit"
        echo "============================================"
        if [ -n "$PHPUNIT_OUTPUT" ]; then
            echo "Last log: $(echo "$PHPUNIT_OUTPUT" | tail -1)"
        else
            echo "No result file produced. Playground may have crashed during boot."
        fi
    fi
fi

if [ -z "$PHPUNIT_OUTPUT" ]; then
    echo ""
    echo "============================================"
    echo "WARNING: No test output captured (playground)"
    echo "============================================"
    echo ""
    FAILED_STEP="PHPUnit tests (no output, playground)"
    rm -f "$RESULT_FILE"
    exit 1
fi

if echo "$PHPUNIT_OUTPUT" | grep -q "NO TEST FILES FOUND"; then
    echo ""
    echo "============================================"
    echo "WARNING: No test files discovered"
    echo "============================================"
    echo ""
    FAILED_STEP="PHPUnit tests (no test files, playground)"
    rm -f "$RESULT_FILE"
    exit 1
fi

rm -f "$RESULT_FILE"

echo ""
echo "Playground test run complete."
