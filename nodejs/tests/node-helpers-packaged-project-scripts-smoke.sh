#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_HELPERS="${ROOT_DIR}/scripts/lib/node-helpers.sh"
PROJECT_SCRIPTS="${ROOT_DIR}/../scripts/lib/project-scripts.sh"
PACKAGED_PROJECT_SCRIPTS="${ROOT_DIR}/scripts/lib/project-scripts.sh"
PACKAGED_NODE_ADAPTER="${ROOT_DIR}/dependency-adapters/examples/nodejs.json"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

test -f "$NODE_HELPERS"
test -f "$PROJECT_SCRIPTS"
test -f "$PACKAGED_PROJECT_SCRIPTS"
test -f "$PACKAGED_NODE_ADAPTER"

bash -c '
    source "$1"
    type homeboy_project_init >/dev/null
    type homeboy_project_has_script >/dev/null
    type homeboy_project_run_script_command >/dev/null
    type homeboy_require_package_json >/dev/null
' _ "$NODE_HELPERS"

PNPM_PROJECT="$TMP_DIR/pnpm-project"
mkdir -p "$PNPM_PROJECT/subdir"
cat > "$PNPM_PROJECT/package.json" <<'EOF'
{"name":"packaged-project-helper","scripts":{"test":"node --test"}}
EOF
touch "$PNPM_PROJECT/pnpm-lock.yaml"

bash -c '
    source "$1"
    homeboy_project_init --ecosystem nodejs --path "$2/subdir"
    [ "$HOMEBOY_PROJECT_ROOT" = "$2" ]
    [ "$HOMEBOY_PROJECT_DEPENDENCY_ROOT" = "$2" ]
    [ "$HOMEBOY_PROJECT_PACKAGE_MANAGER" = "pnpm" ]
    [ "$(homeboy_project_run_script_command test)" = "pnpm run test" ]
' _ "$PROJECT_SCRIPTS" "$PNPM_PROJECT"

WORKSPACE_PROJECT="$TMP_DIR/workspace-project"
mkdir -p "$WORKSPACE_PROJECT/packages/plugin/subdir"
cat > "$WORKSPACE_PROJECT/package.json" <<'EOF'
{"name":"workspace-root","scripts":{"root":"node root.js"}}
EOF
cat > "$WORKSPACE_PROJECT/packages/plugin/package.json" <<'EOF'
{"name":"workspace-plugin","scripts":{"test":"node plugin.js"}}
EOF
touch "$WORKSPACE_PROJECT/pnpm-lock.yaml" "$WORKSPACE_PROJECT/pnpm-workspace.yaml"

bash -c '
    source "$1"
    homeboy_project_init --ecosystem nodejs --path "$2/packages/plugin/subdir"
    [ "$HOMEBOY_PROJECT_ROOT" = "$2/packages/plugin" ]
    [ "$HOMEBOY_PROJECT_DEPENDENCY_ROOT" = "$2" ]
    [ "$HOMEBOY_PROJECT_PACKAGE_MANAGER" = "pnpm" ]
    [ "$(homeboy_project_run_script_command test)" = "pnpm run test" ]
' _ "$PROJECT_SCRIPTS" "$WORKSPACE_PROJECT"

INSTALLED_ROOT="$TMP_DIR/installed/extensions"
mkdir -p "$INSTALLED_ROOT"
cp -R "$ROOT_DIR" "$INSTALLED_ROOT/nodejs"
INSTALLED_NODE_HELPERS="$INSTALLED_ROOT/nodejs/scripts/lib/node-helpers.sh"

test ! -e "$INSTALLED_ROOT/scripts/lib/project-scripts.sh"

bash -c '
    source "$1"
    homeboy_project_init --ecosystem nodejs --path "$2/packages/plugin/subdir"
    [ "$PROJECT_SCRIPTS_HELPER" = "$3/scripts/lib/project-scripts.sh" ]
    [ "$HOMEBOY_DEPENDENCY_ADAPTERS_PATH" = "" ]
    [ "$HOMEBOY_PROJECT_ROOT" = "$2/packages/plugin" ]
    [ "$HOMEBOY_PROJECT_DEPENDENCY_ROOT" = "$2" ]
    [ "$HOMEBOY_PROJECT_PACKAGE_MANAGER" = "pnpm" ]
    [ "$(homeboy_project_run_script_command test)" = "pnpm run test" ]
' _ "$INSTALLED_NODE_HELPERS" "$WORKSPACE_PROJECT" "$INSTALLED_ROOT/nodejs"
