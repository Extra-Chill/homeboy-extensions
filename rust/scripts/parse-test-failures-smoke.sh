#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="$(mktemp "${TMPDIR:-/tmp}/rust-test-failures-output.XXXXXX")"
RESULTS="$(mktemp "${TMPDIR:-/tmp}/rust-test-failures-json.XXXXXX")"
trap 'rm -f "$OUTPUT" "$RESULTS"' EXIT

cat > "$OUTPUT" <<'EOF'
running 2 tests
test crate::tests::failed_only ... FAILED

---- crate::tests::panic_before_summary stdout ----
thread 'crate::tests::panic_before_summary' panicked at src/lib.rs:42:9:
assertion failed: expected provider execution count 1, observed 0
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

failures:
    crate::tests::panic_before_summary
    crate::tests::failed_only

test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out
EOF

python3 "$SCRIPT_DIR/parse-test-failures.py" /project "$OUTPUT" "$RESULTS"
python3 - "$RESULTS" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    records = json.load(handle)

assert len(records) == 2, records
panic = next(record for record in records if record["test_id"] == "crate::tests::panic_before_summary")
assert panic["diagnostic"]["location"] == "src/lib.rs:42:9", panic
assert "expected provider execution count 1" in panic["message"], panic
assert panic["rerun_action"] == {"producer": "rust.cargo-test", "id": "cargo.test", "arguments": ["crate::tests::panic_before_summary"]}, panic
assert panic["schema"] == "homeboy/test-failure-diagnostic/v1", panic
assert len(panic["evidence"]["sha256"]) == 64, panic
assert panic["evidence"]["relationship"] == "full_output", panic
assert panic["stdout_excerpt"]
PY

printf 'thread malformed panic output\n' > "$OUTPUT"
python3 "$SCRIPT_DIR/parse-test-failures.py" /project "$OUTPUT" "$RESULTS"
python3 - "$RESULTS" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    records = json.load(handle)

assert len(records) == 1, records
assert records[0]["test_id"] == "cargo test", records
assert records[0]["failure_type"] == "infrastructure", records
assert len(records[0]["evidence"]["sha256"]) == 64, records
PY

{
    printf "thread 'crate::tests::bounded' panicked at src/lib.rs:7:3:\n"
    printf 'x%.0s' {1..2048}
    printf '\n'
} > "$OUTPUT"
python3 "$SCRIPT_DIR/parse-test-failures.py" /project "$OUTPUT" "$RESULTS"
python3 - "$RESULTS" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    record = json.load(handle)[0]

assert record["test_id"] == "crate::tests::bounded", record
assert len(record["message"].encode()) == 1024, record
assert record["diagnostic"]["location"] == "src/lib.rs:7:3", record
PY

printf 'Rust test-failure parser smoke passed\n'
