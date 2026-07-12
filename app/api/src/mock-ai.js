// Deterministic mock models. XML selects the model and supplies each threshold.
// A real adapter can replace this module without changing the browser contract.

export class MockAiError extends Error {}

function strictNumber(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredParam(params, name) {
  const v = strictNumber(params[name]);
  if (v === undefined) throw new MockAiError(`missing or non-numeric param "${name}"`);
  return v;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Confidence drops near a cutoff: borderline readings route to the workflow's
// low-confidence step instead of pretending certainty.
function cutoffConfidence(value, cutoffs) {
  const dist = Math.min(...cutoffs.map((c) => Math.abs(value - c)));
  return clamp(0.3 + (dist / 2) * 0.7, 0.3, 0.99);
}

const thresholdBands = {
  version: '1.0.0',
  run(inputs, params) {
    const value = inputs.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new MockAiError('input "value" must be a finite number');
    const severeBelow = requiredParam(params, 'severeBelow');
    const moderateBelow = requiredParam(params, 'moderateBelow');
    const label = value < severeBelow ? 'severe' : value < moderateBelow ? 'moderate' : 'normal';
    const score = label === 'severe' ? clamp(0.85 + (severeBelow - value) / 20, 0.85, 0.99)
      : label === 'moderate' ? 0.6
      : clamp(0.25 - (value - moderateBelow) / 40, 0.05, 0.25);
    return { label, score: Number(score.toFixed(2)), confidence: Number(cutoffConfidence(value, [severeBelow, moderateBelow]).toFixed(2)), modelVersion: `${'threshold-bands'}@${this.version}` };
  },
};

const weightedScore = {
  version: '1.0.0',
  run(inputs, params) {
    const referAt = requiredParam(params, 'referAt');
    const values = Object.values(inputs);
    if (values.length === 0) throw new MockAiError('no inputs provided');
    const sum = values.reduce((a, b) => a + b, 0);
    const label = sum >= referAt ? 'high-risk' : 'low-risk';
    const score = clamp(sum / (referAt * 2), 0, 1);
    const confidence = clamp(0.3 + (Math.abs(sum - referAt) / referAt) * 0.7, 0.3, 0.99);
    return { label, score: Number(score.toFixed(2)), confidence: Number(confidence.toFixed(2)), modelVersion: `weighted-score@${this.version}` };
  },
};

export const MODELS = new Map([
  ['threshold-bands', thresholdBands],
  ['weighted-score', weightedScore],
]);

export const MODEL_VERSIONS = new Map(
  [...MODELS.entries()].map(([id, m]) => [id, m.version]),
);

function contractKey(step) {
  const match = /^\^(\d+)$/.exec(step.modelVersion);
  return match ? `${step.model}@${match[1]}` : undefined;
}

function unexpectedParamErrors(step, allowed, where) {
  return Object.keys(step.params)
    .filter((name) => !allowed.includes(name))
    .map((name) => `${where}: model "${step.model}" has unknown param "${name}"`);
}

function numericParam(step, name, where, errors) {
  const value = strictNumber(step.params[name]);
  if (value === undefined) {
    errors.push(`${where}: model "${step.model}" param "${name}" must be numeric`);
  }
  return value;
}

// The two Day 1 adapters have deliberately small author-facing contracts.
// Generic workflow rules stay in Engine 1; these rules describe only what
// each bundled model accepts and returns.
export const MODEL_CONTRACTS = new Map([
  ['threshold-bands@1', {
    labels: ['severe', 'moderate', 'normal'],
    validateStep(step, where) {
      const errors = unexpectedParamErrors(step, ['severeBelow', 'moderateBelow'], where);
      const modelInputs = step.inputs.filter((binding) => binding.bind !== 'file');
      if (modelInputs.length !== 1 || modelInputs[0].as !== 'value' || modelInputs[0].bind !== 'value') {
        errors.push(`${where}: model "threshold-bands" requires exactly one numeric input bound as "value"`);
      }
      const severeBelow = numericParam(step, 'severeBelow', where, errors);
      const moderateBelow = numericParam(step, 'moderateBelow', where, errors);
      if (severeBelow !== undefined && moderateBelow !== undefined && severeBelow >= moderateBelow) {
        errors.push(`${where}: model "threshold-bands" requires severeBelow < moderateBelow`);
      }
      return errors;
    },
  }],
  ['weighted-score@1', {
    labels: ['high-risk', 'low-risk'],
    validateStep(step, where) {
      const errors = unexpectedParamErrors(step, ['referAt'], where);
      if (step.inputs.some((binding) => binding.bind === 'file')) {
        errors.push(`${where}: model "weighted-score" does not accept file inputs`);
      }
      const modelInputs = step.inputs.filter((binding) => binding.bind !== 'file');
      if (modelInputs.length === 0 || modelInputs.some((binding) => binding.bind !== 'score')) {
        errors.push(`${where}: model "weighted-score" requires one or more numeric score inputs`);
      }
      const referAt = numericParam(step, 'referAt', where, errors);
      if (referAt !== undefined && referAt <= 0) {
        errors.push(`${where}: model "weighted-score" requires referAt > 0`);
      }
      return errors;
    },
  }],
]);

export function validateModelContracts(workflow) {
  const errors = [];
  for (const step of workflow.steps) {
    if (step.kind !== 'ai') continue;
    const key = contractKey(step);
    if (!key) continue; // Engine 1 reports malformed version constraints.
    const contract = MODEL_CONTRACTS.get(key);
    const where = `step "${step.id}"`;
    if (!contract) {
      errors.push(`${where}: no API contract is installed for model "${key}"`);
      continue;
    }
    errors.push(...contract.validateStep(step, where));
  }
  return errors;
}

export function validateModelResult(step, result) {
  const contract = MODEL_CONTRACTS.get(contractKey(step));
  if (!contract) return [`no result contract is installed for model "${step.model}"`];
  if (!result || typeof result !== 'object') return ['model result must be an object'];

  const errors = [];
  const allowedFields = new Set(['label', 'score', 'confidence', 'modelVersion']);
  for (const field of Object.keys(result)) {
    if (!allowedFields.has(field)) errors.push(`unexpected result field "${field}"`);
  }
  if (!contract.labels.includes(result.label)) {
    errors.push(`label must be one of: ${contract.labels.join(', ')}`);
  }
  for (const field of ['score', 'confidence']) {
    const value = result[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${field} must be a finite number in [0,1]`);
    }
  }
  const installed = MODELS.get(step.model);
  const expectedVersion = installed && `${step.model}@${installed.version}`;
  if (!expectedVersion || result.modelVersion !== expectedVersion) {
    errors.push(`modelVersion must be "${expectedVersion ?? 'an installed model release'}"`);
  }
  return errors;
}
