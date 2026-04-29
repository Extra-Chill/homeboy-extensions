import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const extensionPath = process.env.HOMEBOY_EXTENSION_PATH;
const timelineHelper = join(extensionPath, 'scripts/trace/lib/timeline.mjs');
const desktopHelper = join(extensionPath, 'scripts/trace/lib/desktop.mjs');
const processHelpers = join(extensionPath, 'scripts/trace/lib/process.sh');
const artifactHelpers = join(extensionPath, 'scripts/trace/lib/artifacts.sh');
const {
  artifactPath,
  recordAssertion,
  recordArtifact,
  recordEvent,
  writeTraceResults,
} = await import(timelineHelper);
const { captureWindowState } = await import(desktopHelper);
const artifacts = [];

recordEvent('scenario', 'start', { helper: 'desktop-helpers' });

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: 'ignore',
});
recordEvent('process', 'launched', { pid: child.pid });

const processTreePath = artifactPath('process-tree.txt');
const processTree = execFileSync('bash', [
  '-c',
  `source "${processHelpers}"; trace_process_tree "${child.pid}"`,
], { encoding: 'utf8' });
writeFileSync(processTreePath, processTree || `${child.pid}\n`);
recordArtifact('process tree', processTreePath, { kind: 'process_tree' });
artifacts.push(processTreePath);

const logPath = artifactPath('dummy.log');
writeFileSync(logPath, 'dummy log line\n');
const tailedLogPath = execFileSync('bash', [
  '-c',
  `source "${artifactHelpers}"; trace_tail_log "${logPath}" "dummy-tail.log"`,
], { encoding: 'utf8' }).trim();
recordArtifact('dummy log tail', tailedLogPath, { kind: 'log' });
artifacts.push(tailedLogPath);

const windowState = await captureWindowState({ fileName: 'window-state.json' });
recordEvent('desktop', 'window_state.result', { status: windowState.status, reason: windowState.reason });

recordAssertion('dummy-process-launched', child.pid ? 'pass' : 'fail', 'Dummy Node process launched', {
  pid: child.pid,
});
recordAssertion('process-tree-artifact', existsSync(processTreePath) ? 'pass' : 'fail', 'Process tree artifact exists');
recordAssertion('log-artifact', existsSync(tailedLogPath) ? 'pass' : 'fail', 'Log artifact exists');

child.kill('SIGTERM');
recordEvent('process', 'terminated', { pid: child.pid });

writeTraceResults({ summary: 'Desktop trace helpers fixture completed' });
