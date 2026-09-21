#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_DEP_SH="${SCRIPT_DIR}/../scripts/release/update-dependency.sh"
WORK_DIR="$(mktemp -d -t homeboy-composer-update.XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

make_package() {
  local package_dir="$1" version="$2" archive="$3"
  mkdir -p "${package_dir}"
  cat > "${package_dir}/composer.json" <<JSON
{"name":"acme/library","version":"${version}","type":"library"}
JSON
  printf '%s\n' "<?php" > "${package_dir}/Library.php"
  (cd "${package_dir}" && zip -q -r "${archive}" composer.json Library.php)
}

ARTIFACTS="${WORK_DIR}/artifacts"
mkdir -p "${ARTIFACTS}"
make_package "${WORK_DIR}/pkg-1.0" "1.0.0" "${ARTIFACTS}/acme-library-1.0.0.zip"
make_package "${WORK_DIR}/pkg-1.1" "1.1.0" "${ARTIFACTS}/acme-library-1.1.0.zip"

NORMAL="${WORK_DIR}/normal"
mkdir -p "${NORMAL}"
cat > "${NORMAL}/composer.json" <<JSON
{
  "name": "acme/app",
  "require": { "acme/library": "1.0.0" },
  "repositories": [{ "type": "artifact", "url": "${ARTIFACTS}" }]
}
JSON
(cd "${NORMAL}" && composer install --no-interaction --no-scripts --no-progress >/dev/null)

NORMAL_PAYLOAD='{"dependency":{"package":"acme/library","version":"1.1.0"}}'
normal_out="$(cd "${NORMAL}" && HOMEBOY_SETTINGS_JSON="${NORMAL_PAYLOAD}" "${UPDATE_DEP_SH}")"
echo "${normal_out}" | jq -e '.success == true and .version == "1.1.0" and .changed == true' >/dev/null
jq -e '.packages[] | select(.name == "acme/library") | .version == "1.1.0"' "${NORMAL}/composer.lock" >/dev/null

normal_json_hash="$(shasum "${NORMAL}/composer.json" | cut -d' ' -f1)"
normal_lock_hash="$(shasum "${NORMAL}/composer.lock" | cut -d' ' -f1)"
noop_out="$(cd "${NORMAL}" && HOMEBOY_SETTINGS_JSON="${NORMAL_PAYLOAD}" "${UPDATE_DEP_SH}")"
echo "${noop_out}" | jq -e '.success == true and .changed == false and .composer_refreshed == false' >/dev/null
[[ "${normal_json_hash}" == "$(shasum "${NORMAL}/composer.json" | cut -d' ' -f1)" ]]
[[ "${normal_lock_hash}" == "$(shasum "${NORMAL}/composer.lock" | cut -d' ' -f1)" ]]

set +e
downgrade_err="$(cd "${NORMAL}" && HOMEBOY_SETTINGS_JSON='{"dependency":{"package":"acme/library","version":"1.0.0"}}' "${UPDATE_DEP_SH}" 2>&1 >/dev/null)"
downgrade_status=$?
set -e
[[ ${downgrade_status} -ne 0 ]]
printf '%s\n' "${downgrade_err}" | grep -q 'refusing to downgrade'
[[ "${normal_json_hash}" == "$(shasum "${NORMAL}/composer.json" | cut -d' ' -f1)" ]]
[[ "${normal_lock_hash}" == "$(shasum "${NORMAL}/composer.lock" | cut -d' ' -f1)" ]]

set +e
failure_err="$(cd "${NORMAL}" && HOMEBOY_SETTINGS_JSON='{"dependency":{"package":"acme/library","version":"9.0.0"}}' "${UPDATE_DEP_SH}" 2>&1 >/dev/null)"
failure_status=$?
set -e
[[ ${failure_status} -ne 0 ]]
[[ "${normal_json_hash}" == "$(shasum "${NORMAL}/composer.json" | cut -d' ' -f1)" ]]
[[ "${normal_lock_hash}" == "$(shasum "${NORMAL}/composer.lock" | cut -d' ' -f1)" ]]
printf '%s\n' "${failure_err}" | grep -q 'left unchanged'

INLINE="${WORK_DIR}/inline"
mkdir -p "${INLINE}"
cat > "${INLINE}/composer.json" <<JSON
{
  "name": "acme/inline-app",
  "require": { "acme/library": "1.0.0" },
  "repositories": [{ "type": "package", "package": {
    "name": "acme/library", "version": "1.0.0",
    "dist": { "type": "zip", "url": "${ARTIFACTS}/acme-library-1.0.0.zip", "reference": "old" },
    "source": { "type": "git", "url": "https://example.test/acme/library.git", "reference": "old" }
  }}]
}
JSON
(cd "${INLINE}" && composer install --no-interaction --no-scripts --no-progress >/dev/null)
inline_out="$(cd "${INLINE}" && HOMEBOY_SETTINGS_JSON='{"dependency":{"package":"acme/library","version":"1.1.0","sha":"new","expected_source":"https://example.test/acme/library.git"}}' "${UPDATE_DEP_SH}")"
echo "${inline_out}" | jq -e '.success == true and .version == "1.1.0"' >/dev/null
jq -e '.repositories[0].package.source.url == "https://example.test/acme/library.git" and .repositories[0].package.source.reference == "new"' "${INLINE}/composer.json" >/dev/null
jq -e '.packages[] | select(.name == "acme/library") | .version == "1.1.0"' "${INLINE}/composer.lock" >/dev/null

echo "PASS: release-update-dependency-composer-smoke"
