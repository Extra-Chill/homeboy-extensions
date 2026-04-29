import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const startTime = performance.now();

function elapsedMs() {
  return Math.max(0, Math.round(performance.now() - startTime));
}

function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

export class TraceTimeline {
  constructor(env = process.env) {
    this.env = env;
    this.componentId = env.HOMEBOY_COMPONENT_ID || 'nodejs';
    this.scenarioId = env.HOMEBOY_TRACE_SCENARIO || '';
    this.resultsFile = env.HOMEBOY_TRACE_RESULTS_FILE || resolve('.node-trace-results.json');
    this.artifactDir = env.HOMEBOY_TRACE_ARTIFACT_DIR || resolve(dirname(this.resultsFile), 'artifacts');
    this.timeline = [];
    this.assertions = [];
    this.artifacts = [];
  }

  recordEvent(source, event, data = {}) {
    const entry = {
      t_ms: elapsedMs(),
      source,
      event,
      data: cleanObject(data) || {},
    };
    this.timeline.push(entry);
    return entry;
  }

  recordAssertion(id, status, message, data = {}) {
    const assertion = {
      id,
      status,
      message,
      data: cleanObject(data) || {},
    };
    this.assertions.push(assertion);
    return assertion;
  }

  recordArtifact(label, path, data = {}) {
    const artifact = {
      label,
      path: this.relativeArtifactPath(path),
      ...cleanObject(data),
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  artifactPath(name) {
    mkdirSync(this.artifactDir, { recursive: true });
    return resolve(this.artifactDir, name);
  }

  relativeArtifactPath(path) {
    const absolute = resolve(path);
    const artifactRoot = resolve(this.artifactDir);
    const rel = relative(artifactRoot, absolute);
    if (!rel.startsWith('..') && !rel.startsWith('/')) {
      return rel || '.';
    }
    return path;
  }

  status() {
    if (this.assertions.some((assertion) => assertion.status === 'fail')) {
      return 'fail';
    }
    if (this.assertions.some((assertion) => assertion.status === 'error')) {
      return 'error';
    }
    return 'pass';
  }

  writeTraceResults({ status = this.status(), summary = 'Trace completed', failure } = {}) {
    const envelope = {
      component_id: this.componentId,
      scenario_id: this.scenarioId,
      status,
      summary,
      timeline: this.timeline,
      assertions: this.assertions,
      artifacts: this.artifacts,
    };
    if (failure) {
      envelope.failure = failure;
    }

    mkdirSync(dirname(this.resultsFile), { recursive: true });
    writeFileSync(this.resultsFile, `${JSON.stringify(envelope, null, 2)}\n`);
    return envelope;
  }
}

export const trace = new TraceTimeline();

export function recordEvent(source, event, data = {}) {
  return trace.recordEvent(source, event, data);
}

export function recordAssertion(id, status, message, data = {}) {
  return trace.recordAssertion(id, status, message, data);
}

export function recordArtifact(label, path, data = {}) {
  return trace.recordArtifact(label, path, data);
}

export function artifactPath(name) {
  return trace.artifactPath(name);
}

export function writeTraceResults(options = {}) {
  return trace.writeTraceResults(options);
}
