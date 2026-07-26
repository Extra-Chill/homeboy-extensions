#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_PATH="${HOMEBOY_COMPONENT_PATH:-${PROJECT_PATH:-$(pwd)}}"
ACTION="${1:-status}"
PACKAGE_FILTER="${2:-}"
COMPOSER_METADATA_SNAPSHOT_DIR=""
COMPOSER_METADATA_PATHS=()
COMPOSER_METADATA_STATES=()

snapshot_composer_metadata() {
    local repository_root project_prefix tracked_path snapshot_path
    repository_root="$(git -C "$PROJECT_PATH" rev-parse --show-toplevel 2>/dev/null)" || return 0
    project_prefix="$(git -C "$PROJECT_PATH" rev-parse --show-prefix 2>/dev/null)"
    COMPOSER_METADATA_SNAPSHOT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/homeboy-composer-metadata.XXXXXX")"

    while IFS= read -r -d '' tracked_path; do
        snapshot_path="$COMPOSER_METADATA_SNAPSHOT_DIR/${#COMPOSER_METADATA_PATHS[@]}"
        COMPOSER_METADATA_PATHS+=("$tracked_path")
        if [ -e "$repository_root/$tracked_path" ]; then
            cp -p "$repository_root/$tracked_path" "$snapshot_path"
            COMPOSER_METADATA_STATES+=("present")
        else
            COMPOSER_METADATA_STATES+=("absent")
        fi
    done < <(git -C "$PROJECT_PATH" ls-files -z --full-name -- ":(top)${project_prefix}vendor/composer")
}

restore_composer_metadata() {
    local status=$? repository_root index tracked_path snapshot_path state
    [ -n "$COMPOSER_METADATA_SNAPSHOT_DIR" ] || return "$status"
    repository_root="$(git -C "$PROJECT_PATH" rev-parse --show-toplevel 2>/dev/null)" || return "$status"

    for index in "${!COMPOSER_METADATA_PATHS[@]}"; do
        tracked_path="${COMPOSER_METADATA_PATHS[$index]}"
        snapshot_path="$COMPOSER_METADATA_SNAPSHOT_DIR/$index"
        state="${COMPOSER_METADATA_STATES[$index]}"
        if [ "$state" = "present" ] && ! cmp -s "$snapshot_path" "$repository_root/$tracked_path"; then
            mkdir -p "$(dirname "$repository_root/$tracked_path")"
            cp -p "$snapshot_path" "$repository_root/$tracked_path"
        elif [ "$state" = "absent" ] && [ -e "$repository_root/$tracked_path" ]; then
            rm -f "$repository_root/$tracked_path"
        fi
    done

    rm -rf "$COMPOSER_METADATA_SNAPSHOT_DIR"
    COMPOSER_METADATA_SNAPSHOT_DIR=""
    return "$status"
}

has_composer() {
    [ -f "${PROJECT_PATH}/composer.json" ]
}

has_package_json() {
    [ -f "${PROJECT_PATH}/package.json" ]
}

npm_install_command() {
    if [ -f "${PROJECT_PATH}/package-lock.json" ]; then
        printf '%s\n' "npm ci"
    else
        printf '%s\n' "npm install --no-audit --no-fund"
    fi
}

emit_status() {
    HOMEBOY_WORDPRESS_DEPS_PROJECT_PATH="$PROJECT_PATH" \
    HOMEBOY_WORDPRESS_DEPS_PACKAGE_FILTER="$PACKAGE_FILTER" \
        node <<'NODE'
const fs = require('fs');
const path = require('path');

const projectPath = process.env.HOMEBOY_WORDPRESS_DEPS_PROJECT_PATH;
const filter = process.env.HOMEBOY_WORDPRESS_DEPS_PACKAGE_FILTER || '';
const packages = [];
const dependencyIdentities = [];
const lockfiles = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(projectPath, file), 'utf8'));
}

function pushPackage(name, section, constraint) {
  if (!name || (filter && filter !== name)) return;
  packages.push({ name, manifest_section: section, constraint: String(constraint) });
}

if (fs.existsSync(path.join(projectPath, 'composer.json'))) {
  const composer = readJson('composer.json');
  if (composer.name) dependencyIdentities.push(String(composer.name));
  for (const section of ['require', 'require-dev']) {
    for (const [name, constraint] of Object.entries(composer[section] || {})) {
      pushPackage(name, section, constraint);
    }
  }
  if (fs.existsSync(path.join(projectPath, 'composer.lock'))) lockfiles.push('composer.lock');
}

if (fs.existsSync(path.join(projectPath, 'package.json'))) {
  const pkg = readJson('package.json');
  if (pkg.name) dependencyIdentities.push(String(pkg.name));
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, constraint] of Object.entries(pkg[section] || {})) {
      pushPackage(name, section, constraint);
    }
  }
  for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
    if (fs.existsSync(path.join(projectPath, lockfile))) lockfiles.push(lockfile);
  }
}

process.stdout.write(JSON.stringify({
  package_manager: 'wordpress',
  dependency_identities: [...new Set(dependencyIdentities)],
  lockfiles,
  packages,
  errors: [],
}) + '\n');
NODE
}

emit_install_command() {
    HOMEBOY_WORDPRESS_DEPS_RUNNER="${SCRIPT_DIR}/deps-runner.sh" node <<'NODE'
process.stdout.write(JSON.stringify({
  command: ['bash', process.env.HOMEBOY_WORDPRESS_DEPS_RUNNER, 'install'],
}) + '\n');
NODE
}

run_install() {
    local ran=0
    if has_composer; then
        echo "Installing WordPress PHP dependencies with composer" >&2
        snapshot_composer_metadata
        trap 'restore_composer_metadata' EXIT
        (cd "$PROJECT_PATH" && composer install --no-interaction --prefer-dist)
        trap - EXIT
        restore_composer_metadata
        ran=1
    fi
    if has_package_json; then
        local command
        command="$(npm_install_command)"
        echo "Installing WordPress JavaScript dependencies: ${command}" >&2
        (cd "$PROJECT_PATH" && $command)
        ran=1
    fi
    if [ "$ran" -eq 0 ]; then
        echo "No composer.json or package.json found in ${PROJECT_PATH}; nothing to install" >&2
    fi
}

case "$ACTION" in
    status)
        emit_status
        ;;
    install-command)
        emit_install_command
        ;;
    install)
        run_install
        ;;
    update)
        echo "wordpress deps update is not implemented" >&2
        exit 64
        ;;
    *)
        echo "unknown wordpress deps action: $ACTION" >&2
        exit 64
        ;;
esac
