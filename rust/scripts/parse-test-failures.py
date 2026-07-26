#!/usr/bin/env python3
"""Distill Cargo test failures without making Homeboy parse Cargo output."""

import hashlib
import json
import os
import re
import sys

MAX_FAILURES = 100
MAX_FIELD_BYTES = 1024
MAX_EXCERPT_BYTES = 4000
SCHEMA = "homeboy/test-failure-diagnostic/v1"
PRODUCER = "rust.cargo-test"


def bounded(value, limit):
    return value.encode("utf-8")[:limit].decode("utf-8", "ignore").strip()


def relpath(value, project):
    if not value:
        return None
    try:
        relative = os.path.relpath(value, project)
    except ValueError:
        return value
    return relative if not relative.startswith("../") else value


def failure(test_id, output, output_sha256, location=None, message=None):
    identity = bounded(test_id, MAX_FIELD_BYTES) or "cargo test"
    location = bounded(relpath(location, PROJECT), MAX_FIELD_BYTES) if location else None
    message = bounded(message or "Rust test failed; inspect the complete Cargo output.", MAX_FIELD_BYTES)
    fingerprint_namespace = "rust:cargo-test:failed" if identity == "cargo test" else "rust:test:" + identity
    fingerprint = hashlib.sha256(fingerprint_namespace.encode()).hexdigest()
    return {
        # v1 fields remain authoritative for existing sidecar consumers.
        "test_id": identity,
        "suite": None,
        "file": location.rsplit(":", 2)[0] if location else None,
        "line": int(location.rsplit(":", 2)[1]) if location and re.search(r":\d+:\d+$", location) else None,
        "message": message,
        "failure_type": "test_failure",
        "fingerprint": fingerprint,
        "stdout_excerpt": bounded(output[-MAX_EXCERPT_BYTES:], MAX_EXCERPT_BYTES),
        "stderr_excerpt": "",
        # The generic diagnostic envelope is additive to the v1 record.
        "id": fingerprint,
        "schema": SCHEMA,
        "producer": PRODUCER,
        "diagnostic": {
            "identity": identity,
            "summary": message,
            "location": location,
        },
        "rerun_action": {
            "producer": PRODUCER,
            "id": "cargo.test",
            "arguments": [identity],
        },
        "rerun_command": "cargo test " + identity,
        "evidence": {
            "relationship": "full_output",
            "sha256": output_sha256,
        },
    }


def add(records, seen, test_id, output, output_sha256, location=None, message=None):
    if not test_id:
        return
    if test_id in seen:
        if location or message:
            for index, record in enumerate(records):
                if record["test_id"] == test_id:
                    records[index] = failure(test_id, output, output_sha256, location, message)
                    break
        return
    if len(records) >= MAX_FAILURES:
        return
    seen.add(test_id)
    records.append(failure(test_id, output, output_sha256, location, message))


def parse(output, output_sha256):
    records = []
    seen = set()
    lines = output.splitlines()
    sections = {}
    current = None

    for index, raw in enumerate(lines):
        section = re.match(r"^---- (?P<name>.+) stdout ----$", raw)
        if section:
            current = section.group("name")
            sections.setdefault(current, [])
            continue
        if raw.startswith("---- ") and raw.endswith(" ----"):
            current = None
            continue
        if current:
            sections[current].append(raw)

        failed = re.match(r"^test (?P<name>.+) \.\.\. FAILED$", raw)
        if failed:
            add(records, seen, failed.group("name"), output, output_sha256)

        panic = re.match(r"^thread '(?P<name>.+)' panicked at (?P<location>.+):$", raw)
        if panic:
            message = next((line.strip() for line in lines[index + 1:] if line.strip() and not line.startswith("note:")), None)
            add(records, seen, panic.group("name"), output, output_sha256, panic.group("location"), message)

    for name, section_lines in sections.items():
        section = "\n".join(section_lines)
        panic = re.search(r"^thread '.+' panicked at (?P<location>.+):$", section, re.MULTILINE)
        message = None
        if panic:
            after_panic = section[panic.end():].splitlines()
            message = next((line.strip() for line in after_panic if line.strip() and not line.startswith("note:")), None)
        add(records, seen, name, output, output_sha256, panic.group("location") if panic else None, message)

    failures_header = next((index for index, line in enumerate(lines) if line.strip() == "failures:"), None)
    if failures_header is not None:
        for raw in lines[failures_header + 1:]:
            if raw.startswith("test result:") or raw.strip() == "":
                continue
            if raw.startswith("error:") or raw.startswith("failures:"):
                break
            candidate = raw.strip()
            if re.match(r"^[A-Za-z0-9_:./#\-\[\] ]+$", candidate):
                add(records, seen, candidate, output, output_sha256)

    return records


PROJECT, OUTPUT_FILE, TARGET = sys.argv[1:]
with open(OUTPUT_FILE, encoding="utf-8", errors="replace") as handle:
    OUTPUT = handle.read()

OUTPUT_SHA256 = hashlib.sha256(OUTPUT.encode()).hexdigest()
failures = parse(OUTPUT, OUTPUT_SHA256)
if not failures:
    fallback = failure("cargo test", OUTPUT, OUTPUT_SHA256,
                       message="cargo test failed before individual test failures could be parsed")
    fallback["failure_type"] = "infrastructure"
    failures = [fallback]

with open(TARGET, "w", encoding="utf-8") as handle:
    json.dump(failures, handle, indent=2)
    handle.write("\n")
