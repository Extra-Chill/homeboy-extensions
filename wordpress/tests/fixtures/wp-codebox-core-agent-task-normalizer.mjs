export function normalizeAgentTaskRunResult(raw, options = {}) {
  const result = raw && typeof raw === 'object' ? raw : {};
  const runtime = result.run?.runtime || {};
  const agentResult = result.run?.agentResult || result.agentResult || result.agent_result || {};
  const patch = agentResult.patch || {};
  const changedFiles = agentResult.changedFiles || {};
  const status = result.timeout
    ? 'timeout'
    : (result.success === true && result.status === 'completed' && options.exitStatus === 0 ? 'succeeded' : 'failed');

  return {
    schema: 'wp-codebox/agent-task-run-result/v1',
    status,
    success: status === 'succeeded',
    summary: result.summary || `fixture normalized ${status}`,
    artifacts: [{
      id: 'fixture-normalized-patch',
      kind: 'codebox-patch',
      path: '/tmp/fixture-normalized/patch.diff',
      sha256: patch.sha256,
    }],
    refs: {
      artifact_bundles: [],
      changed_files: [],
      patches: [],
      transcripts: [],
      logs: [],
      runtimes: [],
    },
    diagnostics: [{ class: 'fixture.normalizer', message: 'Fixture normalizer was used.', data: { exitStatus: options.exitStatus } }],
    metadata: {
      run_id: result.run?.runId,
      run_status: result.run?.status,
      runtime_id: runtime.id,
      runtime_status: runtime.status,
      changed_files_count: changedFiles.count,
      patch_bytes: patch.bytes,
      patch_sha256: patch.sha256,
    },
    no_op: { detected: false },
    failure_classification: status === 'failed' ? 'runtime' : undefined,
  };
}

export function normalizeRecipeRunSummary(raw) {
  const recipeRun = raw && typeof raw === 'object' ? raw : {};
  const failedPhase = recipeRun.phaseEvidence?.findLast?.((phase) => phase.status === 'failed')?.name
    || recipeRun.diagnostics?.find?.((diagnostic) => diagnostic.phase)?.phase;
  const artifacts = [];
  if (recipeRun.artifacts?.runtimeLogPath) {
    artifacts.push({ id: recipeRun.artifacts.runtimeLogPath, kind: 'codebox-runtime-log', path: recipeRun.artifacts.runtimeLogPath });
  }
  if (recipeRun.artifacts?.commandsLogPath) {
    artifacts.push({ id: recipeRun.artifacts.commandsLogPath, kind: 'codebox-command-log', path: recipeRun.artifacts.commandsLogPath });
  }
  if (recipeRun.artifacts?.diffsPath) {
    artifacts.push({ id: recipeRun.artifacts.diffsPath, kind: 'recipe-side-effects', path: recipeRun.artifacts.diffsPath });
  }
  for (const probe of recipeRun.probes || []) {
    const summary = probe.summary || {};
    if (summary.summaryFile) {
      artifacts.push({ id: summary.summaryFile, kind: 'browser-summary', path: summary.summaryFile });
    }
    if (summary.screenshot) {
      artifacts.push({ id: summary.screenshot, kind: 'browser-screenshot', path: summary.screenshot });
    }
  }
  for (const artifact of recipeRun.declaredArtifacts || []) {
    artifacts.push({ id: artifact.name || artifact.path, kind: 'recipe-declared-artifact', path: artifact.path, metadata: artifact });
  }

  return {
    schema: 'wp-codebox/recipe-run-summary/v1',
    success: recipeRun.success !== false,
    status: recipeRun.success === false ? 'failed' : 'succeeded',
    failed_phase: failedPhase,
    failure_summary: recipeRun.success === false ? `${failedPhase}: ${recipeRun.error?.message || 'WP Codebox recipe run failed.'}` : undefined,
    diagnostics: recipeRun.diagnostics || [],
    artifacts,
    refs: {
      startup_logs: artifacts.filter((artifact) => artifact.kind === 'codebox-runtime-log' || artifact.kind === 'codebox-command-log'),
      probe_json: artifacts.filter((artifact) => artifact.kind === 'browser-summary'),
      screenshots: artifacts.filter((artifact) => artifact.kind === 'browser-screenshot'),
      side_effects: artifacts.filter((artifact) => artifact.kind === 'recipe-side-effects'),
      declared_artifacts: artifacts.filter((artifact) => artifact.kind === 'recipe-declared-artifact'),
      artifact_bundles: [],
      changed_files: [],
      patches: [],
      transcripts: [],
      logs: [],
      runtimes: [],
    },
    metadata: {
      run_id: recipeRun.run?.runId,
      run_status: recipeRun.run?.status,
      failure_phase: failedPhase,
      failure_classification: recipeRun.success === false ? 'runtime' : undefined,
      recipe_path: recipeRun.recipePath,
    },
  };
}
