#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PHPSTAN_RUNNER="${ROOT_DIR}/scripts/lint/phpstan-runner.sh"

assert_contains() {
    local file="$1"
    local expected="$2"
    if ! grep -Fq -- "$expected" "$file"; then
        echo "Expected $file to contain: $expected" >&2
        echo "Actual contents:" >&2
        cat "$file" >&2
        exit 1
    fi
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

COMPONENT_DIR="${TMP_DIR}/html-to-blocks-converter"
FAKE_EXTENSION="${TMP_DIR}/fake-wordpress-extension"
CAPTURE_FILE="${TMP_DIR}/phpstan-capture.txt"

mkdir -p "${COMPONENT_DIR}/includes" "${FAKE_EXTENSION}/vendor/bin"

cat > "${COMPONENT_DIR}/html-to-blocks-converter.php" <<'PHP'
<?php
/**
 * Plugin Name: HTML To Blocks Converter
 */
PHP

cat > "${COMPONENT_DIR}/includes/class-html-element.php" <<'PHP'
<?php

class HTML_To_Blocks_HTML_Element {}
PHP

cat > "${COMPONENT_DIR}/includes/class-transform-registry.php" <<'PHP'
<?php

class HTML_To_Blocks_Transform_Registry {
    public function register( HTML_To_Blocks_HTML_Element $element ): void {}
}
PHP

cat > "${FAKE_EXTENSION}/phpstan.neon.dist" <<'NEON'
parameters:
    level: 7
NEON

cat > "${FAKE_EXTENSION}/vendor/bin/phpstan" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

config=""
targets=()
for arg in "$@"; do
    case "$arg" in
        --configuration=*) config="${arg#--configuration=}" ;;
        *.php) targets+=("$arg") ;;
    esac
done

{
    echo "config=${config}"
    echo "target_count=${#targets[@]}"
    printf 'target=%s\n' "${targets[@]}"
    echo "---config---"
    cat "$config"
} > "$PHPSTAN_CAPTURE"

if [ "${#targets[@]}" -ne 1 ]; then
    echo "Expected scoped PHPStan to analyze one target, got ${#targets[@]}" >&2
    exit 1
fi

if [ "${targets[0]}" != "${HOMEBOY_COMPONENT_PATH}/includes/class-transform-registry.php" ]; then
    echo "Expected scoped PHPStan target to remain the requested file" >&2
    exit 1
fi

if ! grep -Fq -- "- ${HOMEBOY_COMPONENT_PATH}" "$config"; then
    echo "Expected scoped PHPStan config to scan the component for sibling declarations" >&2
    exit 1
fi

exit 0
SH
chmod +x "${FAKE_EXTENSION}/vendor/bin/phpstan"

HOMEBOY_EXTENSION_PATH="$FAKE_EXTENSION" \
HOMEBOY_COMPONENT_PATH="$COMPONENT_DIR" \
HOMEBOY_COMPONENT_ID="html-to-blocks-converter" \
HOMEBOY_LINT_FILE="includes/class-transform-registry.php" \
HOMEBOY_CACHE_DIR="$TMP_DIR" \
PHPSTAN_CAPTURE="$CAPTURE_FILE" \
    bash "$PHPSTAN_RUNNER" > "${TMP_DIR}/phpstan.out" 2>&1

assert_contains "${TMP_DIR}/phpstan.out" "PHPStan scoped lint: analyzing 1 PHP file(s) from requested scope"
assert_contains "$CAPTURE_FILE" "target_count=1"
assert_contains "$CAPTURE_FILE" "target=${COMPONENT_DIR}/includes/class-transform-registry.php"
assert_contains "$CAPTURE_FILE" "- ${COMPONENT_DIR}"

echo "phpstan scoped component context smoke passed"
