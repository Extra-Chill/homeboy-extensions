#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="${SCRIPT_DIR}/eslint-runner.sh"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

EXTENSION_DIR="${TMPDIR}/extension"
COMPONENT_DIR="${TMPDIR}/component"
ARGS_FILE="${TMPDIR}/eslint-args.txt"
CALLS_FILE="${TMPDIR}/eslint-calls.txt"
OUTPUT_FILE="${TMPDIR}/eslint-output.txt"

mkdir -p "${EXTENSION_DIR}/node_modules/.bin" "${COMPONENT_DIR}/includes" "${COMPONENT_DIR}/assets"
touch "${EXTENSION_DIR}/.eslintrc.json"
touch "${COMPONENT_DIR}/plugin.php" "${COMPONENT_DIR}/includes/Admin.php" "${COMPONENT_DIR}/assets/app.js"

cat > "${EXTENSION_DIR}/node_modules/.bin/eslint" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

count=0
[ -f "${ESLINT_CALLS_FILE}" ] && count=$(cat "${ESLINT_CALLS_FILE}")
count=$((count + 1))
printf '%s\n' "$count" > "${ESLINT_CALLS_FILE}"
printf '%s\n' "$@" > "${ESLINT_ARGS_FILE}"

for arg in "$@"; do
    if [ "$arg" = "json" ]; then
        printf '%s\n' '[]'
        exit 0
    fi
done

exit 0
SH
chmod +x "${EXTENSION_DIR}/node_modules/.bin/eslint"

run_eslint() {
    local glob="$1"

    : > "$ARGS_FILE"
    printf '0\n' > "$CALLS_FILE"
    : > "$OUTPUT_FILE"

    HOMEBOY_EXTENSION_PATH="$EXTENSION_DIR" \
    HOMEBOY_COMPONENT_PATH="$COMPONENT_DIR" \
    HOMEBOY_COMPONENT_ID="eslint-scoped-glob-smoke" \
    HOMEBOY_LINT_GLOB="$glob" \
    HOMEBOY_SUMMARY_MODE=1 \
    ESLINT_ARGS_FILE="$ARGS_FILE" \
    ESLINT_CALLS_FILE="$CALLS_FILE" \
        "$RUNNER" >"$OUTPUT_FILE" 2>&1
}

assert_contains() {
    local needle="$1"
    local file="$2"
    local message="$3"

    if ! grep -F -- "$needle" "$file" >/dev/null; then
        echo "FAIL: $message" >&2
        sed 's/^/  /' "$file" >&2
        exit 1
    fi
}

assert_not_contains() {
    local needle="$1"
    local file="$2"
    local message="$3"

    if grep -F -- "$needle" "$file" >/dev/null; then
        echo "FAIL: $message" >&2
        sed 's/^/  /' "$file" >&2
        exit 1
    fi
}

run_eslint '{plugin.php,includes/Admin.php}'

if [ "$(cat "$CALLS_FILE")" != "0" ]; then
    echo "FAIL: PHP-only scoped glob should not invoke ESLint" >&2
    sed 's/^/  /' "$ARGS_FILE" >&2
    exit 1
fi
assert_contains "No JS/TS files match pattern" "$OUTPUT_FILE" "PHP-only scoped glob should print a clear skip message"

run_eslint '{plugin.php,assets/app.js,includes/Admin.php}'

if [ "$(cat "$CALLS_FILE")" != "1" ]; then
    echo "FAIL: mixed scoped glob should invoke ESLint once in summary mode" >&2
    sed 's/^/  /' "$OUTPUT_FILE" >&2
    exit 1
fi

assert_contains "assets/app.js" "$ARGS_FILE" "mixed scoped glob should pass JS files to ESLint"
assert_not_contains "plugin.php" "$ARGS_FILE" "mixed scoped glob should not pass root PHP file to ESLint"
assert_not_contains "includes/Admin.php" "$ARGS_FILE" "mixed scoped glob should not pass nested PHP file to ESLint"
assert_contains "Linting 1 JS/TS files matching" "$OUTPUT_FILE" "mixed scoped glob should report filtered JS/TS count"

echo "ESLint scoped glob smoke passed"
