# Node.js Trace Helpers

The Node.js extension exposes generic helpers for black-box trace scenarios. Scenarios remain project-owned and can import helper modules from `HOMEBOY_EXTENSION_PATH`.

## JavaScript Helpers

- `scripts/trace/lib/timeline.mjs` records timestamped events, assertions, artifact metadata, and writes the Homeboy trace JSON envelope.
- `scripts/trace/lib/desktop.mjs` captures best-effort desktop evidence. macOS currently supports `osascript` window snapshots and `screencapture` screenshots when those tools are available. Other platforms record skipped evidence instead of failing the scenario.

## Shell Helpers

- `scripts/trace/lib/process.sh` launches tracked processes, captures a process tree using `pstree` or `ps`, and cleans tracked processes on exit/signals.
- `scripts/trace/lib/artifacts.sh` resolves artifact paths and tails log files into `HOMEBOY_TRACE_ARTIFACT_DIR`.

## Fixture

`scripts/trace/fixtures/desktop-helpers.trace.mjs` is a sample scenario that launches a dummy Node process, records events/assertions, captures a process tree artifact, and writes a valid trace envelope.

Project scenarios can copy that fixture or import the helpers directly:

```js
import { join } from 'node:path';
const helper = join(process.env.HOMEBOY_EXTENSION_PATH, 'scripts/trace/lib/timeline.mjs');
const { recordEvent, writeTraceResults } = await import(helper);

recordEvent('scenario', 'started');
writeTraceResults({ summary: 'Scenario complete' });
```
