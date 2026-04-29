#!/usr/bin/env bash

TRACE_SPAWNED_PIDS=()

trace_launch() {
    local command_line="$1"
    bash -c "$command_line" &
    local pid=$!
    TRACE_SPAWNED_PIDS+=("$pid")
    printf '%s\n' "$pid"
}

trace_process_tree() {
    local root_pid="$1"

    if command -v pstree >/dev/null 2>&1; then
        pstree -p "$root_pid" 2>/dev/null || true
        return 0
    fi

    ps -axo pid=,ppid=,stat=,command= | awk -v root="$root_pid" '
        $1 == root || $2 == root { print }
    '
}

trace_cleanup() {
    local pid
    for pid in "${TRACE_SPAWNED_PIDS[@]:-}"; do
        if kill -0 "$pid" >/dev/null 2>&1; then
            kill "$pid" >/dev/null 2>&1 || true
        fi
    done
}

trace_install_cleanup_trap() {
    trap trace_cleanup EXIT INT TERM
}
