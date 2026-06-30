'use strict';

const { evaluateGatePlan, evaluateGateResults } = require('./gate-plan-evaluator');

const AGENT_TASK_LOOP_SCHEMA = 'homeboy/agent-task-loop/v1';

function loopRun(input = {}) {
  const iterations = normalizeArray(input.iterations);
  const evidence = normalizeArray(input.evidence);
  return compactObject({
    schema: AGENT_TASK_LOOP_SCHEMA,
    loop_id: input.loop_id || input.loopId || input.id || 'loop',
    status: input.status || 'completed',
    attempts: normalizeArray(input.attempts).length > 0 ? normalizeArray(input.attempts) : iterations.map(loopAttemptFromIteration),
    finalization: input.finalization || null,
    stop_reason: input.stop_reason || input.stopReason || '',
    // Compatibility fields for runtime-agent-ci evidence envelopes. Homeboy core
    // consumes the schema/loop_id/status/attempts/finalization/stop_reason shape.
    max_iterations: positiveInteger(input.max_iterations || input.maxIterations) || iterations.length,
    iteration_count: positiveInteger(input.iteration_count || input.iterationCount) || iterations.length,
    iterations,
    evidence,
    gate_summary: input.gate_summary || input.gateSummary || null,
    data: plainObject(input.data) ? input.data : {},
  });
}

function loopIteration(input = {}) {
  const iteration = positiveInteger(input.iteration || input.attempt) || 1;
  const result = input.result || input.outcome || null;
  const resultStatus = result?.status || result?.state || '';
  return compactObject({
    attempt: iteration,
    run_id: input.run_id || input.runId || input.task_id || input.taskId || `${input.loop_id || input.loopId || 'loop'}-${iteration}`,
    run_state: input.run_state || input.runState || resultStatus || (input.accepted === true ? 'completed' : ''),
    aggregate_path: input.aggregate_path || input.aggregatePath || null,
    promotion: input.promotion || null,
    feedback: input.feedback || null,
    loop_id: input.loop_id || input.loopId || '',
    iteration,
    task: input.task || input.input || null,
    result,
    artifacts: normalizeArray(input.artifacts),
    evidence_refs: normalizeArray(input.evidence_refs || input.evidenceRefs || input.evidence),
    gate_result: input.gate_result || input.gateResult || null,
    accepted: input.accepted === true,
    data: plainObject(input.data) ? input.data : {},
  });
}

function loopEvidence(input = {}) {
  const uri = input.uri || input.url || input.href || input.path || input.ref || '';
  return compactObject({
    kind: input.kind || input.type || 'evidence',
    uri,
    ref: uri,
    label: input.label || input.name || input.id || '',
    iteration: input.iteration,
    data: plainObject(input.data) ? input.data : {},
    evidence: input.evidence,
    artifact: input.artifact,
  });
}

function loopAttemptFromIteration(iteration = {}) {
  return compactObject({
    attempt: positiveInteger(iteration.attempt || iteration.iteration) || 1,
    run_id: iteration.run_id || iteration.runId || `${iteration.loop_id || 'loop'}-${iteration.iteration || 1}`,
    run_state: iteration.run_state || iteration.runState || iteration.result?.status || iteration.result?.state || (iteration.accepted === true ? 'completed' : ''),
    aggregate_path: iteration.aggregate_path || iteration.aggregatePath || null,
    promotion: iteration.promotion || null,
    feedback: iteration.feedback || null,
  });
}

function withLoopGateResult(id, result = {}, options = {}) {
  const enabled = result.enabled !== false;
  return {
    ...result,
    gate_result: evaluateGatePlan({
      id,
      label: options.label || id,
      enabled,
      pass_when: [{
        field: 'success',
        op: 'truthy',
        reason: options.reason || id,
        message: result.error || options.message || `${id} failed`,
      }],
    }, { success: !enabled || result.success !== false }),
  };
}

function loopGateSummary(gates) {
  return evaluateGateResults(normalizeArray(gates));
}

function loopSuccessAssertion(input = {}) {
  const scenario = input.scenario || findScenario(input.results, input.scenario_id || input.scenarioId || input.flow_slug || input.flowSlug || '');
  const metadata = plainObject(scenario?.metadata) ? scenario.metadata : {};
  const jobStatus = metadata.job_status || '';
  const successStatus = metadata.success_status || '';
  const errorMessage = metadata.error_message || '';
  const noChangesAllowed = input.success_requires_pr === false || input.successRequiresPr === false;
  const allowedCompletionOutcomes = normalizeArray(input.success_completion_outcomes || input.successCompletionOutcomes);
  const completionOutcome = metadata.completion_outcome || metadata.completionOutcome || '';
  const completionOutcomeSatisfied = metadata.completion_outcome_satisfied === true || Boolean(completionOutcome && allowedCompletionOutcomes.includes(completionOutcome));
  const assertion = {
    scenario_id: scenario?.id || input.scenario_id || input.scenarioId || '',
    job_status: jobStatus,
    success_status: successStatus,
    error_message: errorMessage,
    completion_outcome: completionOutcome,
    completion_outcome_satisfied: completionOutcomeSatisfied,
    no_changes_allowed: noChangesAllowed,
    gate_result: null,
  };

  if (errorMessage) {
    assertion.gate_result = evaluateGatePlan({
      id: 'loop_success_assertion',
      fail_when: [{ field: 'error_message', op: 'present', reason: 'scenario_error', message: successFailureMessage(assertion) }],
    }, assertion);
    return assertion;
  }

  assertion.gate_result = evaluateGatePlan({
    id: 'loop_success_assertion',
    pass_when: [{ field: 'accepted', op: 'truthy', reason: 'loop_success_not_satisfied', message: successFailureMessage(assertion) }],
  }, {
    ...assertion,
    accepted: successStatus === 'pr_opened' || completionOutcomeSatisfied || (['no_changes', 'no_op'].includes(successStatus) && noChangesAllowed),
  });
  return assertion;
}

function assertLoopSuccess(input = {}) {
  const assertion = loopSuccessAssertion(input);
  if (assertion.gate_result.success) {
    return assertion;
  }
  throw new Error(assertion.gate_result.message || successFailureMessage(assertion));
}

function successFailureMessage(assertion) {
  if (assertion.error_message) {
    return `scenario ${assertion.scenario_id} completed with error_message=${assertion.error_message}`;
  }
  return `scenario ${assertion.scenario_id} expected opened PR, satisfied completion outcome, or allowed no-changes result, got job_status=${assertion.job_status} success_status=${assertion.success_status} completion_outcome_satisfied=${assertion.completion_outcome_satisfied ? 'true' : 'false'} no_changes_allowed=${assertion.no_changes_allowed ? 'true' : 'false'}`;
}

function findScenario(results, scenarioId) {
  const scenarios = normalizeArray(results?.scenarios);
  const scenario = scenarioId ? scenarios.find((candidate) => candidate.id === scenarioId) : scenarios[0];
  if (!scenario) {
    throw new Error(`scenario ${scenarioId || '(first)'} was not found in loop results.`);
  }
  return scenario;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''));
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

module.exports = {
  AGENT_TASK_LOOP_SCHEMA,
  assertLoopSuccess,
  loopEvidence,
  loopGateSummary,
  loopIteration,
  loopRun,
  loopSuccessAssertion,
  withLoopGateResult,
};
