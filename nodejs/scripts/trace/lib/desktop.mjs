import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { artifactPath, recordArtifact, recordEvent } from './timeline.mjs';

const execFileAsync = promisify(execFile);

async function commandExists(command) {
  try {
    await execFileAsync('sh', ['-c', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

export async function captureWindowState({ label = 'window state', fileName = 'window-state.json' } = {}) {
  const outputPath = artifactPath(fileName);

  if (process.platform !== 'darwin') {
    recordEvent('desktop', 'window_state.skipped', {
      reason: 'unsupported_platform',
      platform: process.platform,
    });
    return { status: 'skipped', reason: 'unsupported_platform' };
  }

  if (!(await commandExists('osascript'))) {
    recordEvent('desktop', 'window_state.skipped', { reason: 'osascript_missing' });
    return { status: 'skipped', reason: 'osascript_missing' };
  }

  const script = `
set rows to {}
tell application "System Events"
  repeat with proc in (application processes whose background only is false)
    set procName to name of proc
    repeat with win in windows of proc
      set end of rows to procName & tab & (name of win) & tab & (visible of win)
    end repeat
  end repeat
end tell
return my joinRows(rows, linefeed)

on joinRows(rows, delimiter)
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to delimiter
  set textRows to rows as text
  set AppleScript's text item delimiters to oldDelimiters
  return textRows
end joinRows
`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 5000 });
    const windows = stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [app, title, visible] = line.split('\t');
        return { app, title, visible: visible === 'true' };
      });
    await writeFile(outputPath, `${JSON.stringify(windows, null, 2)}\n`);
    recordArtifact(label, outputPath, { kind: 'window_state' });
    recordEvent('desktop', 'window_state.captured', { path: fileName });
    return { status: 'pass', path: outputPath };
  } catch (error) {
    recordEvent('desktop', 'window_state.unknown', {
      reason: 'capture_failed',
      message: error.message,
    });
    return { status: 'unknown', reason: 'capture_failed', message: error.message };
  }
}

export async function captureScreenshot({ label = 'screenshot', fileName = 'screenshot.png' } = {}) {
  const outputPath = artifactPath(fileName);

  if (process.platform !== 'darwin') {
    recordEvent('desktop', 'screenshot.skipped', {
      reason: 'unsupported_platform',
      platform: process.platform,
    });
    return { status: 'skipped', reason: 'unsupported_platform' };
  }

  if (!(await commandExists('screencapture'))) {
    recordEvent('desktop', 'screenshot.skipped', { reason: 'screencapture_missing' });
    return { status: 'skipped', reason: 'screencapture_missing' };
  }

  try {
    await execFileAsync('screencapture', ['-x', outputPath], { timeout: 10000 });
    if (existsSync(outputPath)) {
      recordArtifact(label, outputPath, { kind: 'screenshot' });
      recordEvent('desktop', 'screenshot.captured', { path: fileName });
      return { status: 'pass', path: outputPath };
    }
    recordEvent('desktop', 'screenshot.unknown', { reason: 'missing_output' });
    return { status: 'unknown', reason: 'missing_output' };
  } catch (error) {
    recordEvent('desktop', 'screenshot.unknown', {
      reason: 'capture_failed',
      message: error.message,
    });
    return { status: 'unknown', reason: 'capture_failed', message: error.message };
  }
}
