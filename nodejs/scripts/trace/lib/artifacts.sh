#!/usr/bin/env bash

trace_artifact_dir() {
    printf '%s\n' "${HOMEBOY_TRACE_ARTIFACT_DIR:-${HOMEBOY_RUN_DIR:-.}/artifacts}"
}

trace_artifact_path() {
    local name="$1"
    local dir
    dir="$(trace_artifact_dir)"
    mkdir -p "$dir"
    printf '%s/%s\n' "$dir" "$name"
}

trace_tail_log() {
    local source_log="$1"
    local artifact_name
    artifact_name="${2:-$(basename "$source_log")}"
    local target
    target="$(trace_artifact_path "$artifact_name")"

    if [ ! -f "$source_log" ]; then
        printf 'trace_tail_log: missing source log: %s\n' "$source_log" >&2
        return 2
    fi

    tail -n "${HOMEBOY_TRACE_LOG_LINES:-200}" "$source_log" > "$target"
    printf '%s\n' "$target"
}
