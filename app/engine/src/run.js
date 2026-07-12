import { EngineError } from './types.js';
import { stepsById } from './parse.js';

// Branch conditions see only aliases declared by the AI step's output elements.
function compare(op, actual, expected) {
  if (op === 'in') return expected.split(',').map((s) => s.trim()).includes(String(actual));
  const numeric = typeof actual === 'number' || (actual !== '' && !Number.isNaN(Number(actual)));
  if (numeric && !Number.isNaN(Number(expected))) {
    const a = Number(actual);
    const b = Number(expected);
    switch (op) {
      case 'eq': return a === b;
      case 'ne': return a !== b;
      case 'lt': return a < b;
      case 'lte': return a <= b;
      case 'gt': return a > b;
      case 'gte': return a >= b;
    }
  }
  if (op === 'eq') return String(actual) === expected;
  if (op === 'ne') return String(actual) !== expected;
  return false; // ordered ops on non-numeric values never match
}

function evalWhen(w, answers, aiValues) {
  // Unknown sources never match (fail closed); the validator refuses them anyway.
  const actual = w.source === 'ai' ? aiValues[w.field]
    : w.source === 'answers' ? answers[w.field]
    : undefined;
  if (actual === undefined) return false;
  return compare(w.op, actual, w.value);
}

export function evalCondition(c, answers, aiValues) {
  if ('when' in c) return evalWhen(c.when, answers, aiValues);
  if ('all' in c) return c.all.every((x) => evalCondition(x, answers, aiValues));
  return c.any.some((x) => evalCondition(x, answers, aiValues));
}

export function resolveBranch(step, answers, aiValues) {
  for (const c of step.cases) {
    if (evalCondition(c.condition, answers, aiValues)) return c.step;
  }
  return step.defaultStep;
}

// After an AI result arrives, the workflow decides where to go. Low confidence
// and errors are handled by workflow configuration, not hard-coded branches.
export function aiNextStep(step, result) {
  if (step.lowConfidenceBelow !== undefined && result.confidence < step.lowConfidenceBelow) {
    return step.lowConfidenceStep ?? step.next;
  }
  return step.next;
}

export function applyOutputs(step, result, into) {
  for (const o of step.outputs) into[o.as] = result[o.from];
  return into;
}

export function collectAiValues(wf, aiByStep) {
  const values = {};
  const byId = stepsById(wf);
  for (const [stepId, result] of Object.entries(aiByStep)) {
    const step = byId.get(stepId);
    if (step?.kind === 'ai') applyOutputs(step, result, values);
  }
  return values;
}

export function validateAnswer(field, value) {
  if (field.type === 'number') {
    if (typeof value === 'string' && value.trim() === '') return `"${field.id}" must be a number`;
    const n = Number(value);
    if (!Number.isFinite(n)) return `"${field.id}" must be a finite number`;
    if (field.min !== undefined && n < field.min) return `"${field.id}" must be at least ${field.min}`;
    if (field.max !== undefined && n > field.max) return `"${field.id}" must be at most ${field.max}`;
  }
  if (field.type === 'choice' && !field.options?.some((o) => o.value === String(value))) {
    return `"${field.id}" has no option "${value}"`;
  }
  if (field.type === 'text' && String(value).length > 400) {
    return `"${field.id}" is too long`;
  }
  return null;
}

export function validateAnswers(wf, answers) {
  const errors = [];
  const fields = new Map();
  for (const s of wf.steps) {
    if (s.kind === 'input') for (const f of s.fields) fields.set(f.id, f);
  }
  for (const [id, value] of Object.entries(answers)) {
    const field = fields.get(id);
    if (!field) { errors.push(`unknown answer "${id}"`); continue; }
    if (field.type === 'image') continue; // images travel to the AI endpoint, not in answers
    const err = validateAnswer(field, value);
    if (err) errors.push(err);
  }
  return errors;
}

// Recompute the whole path server-side: the client's claimed outcome must be the
// one the workflow itself produces from the answers and the stored AI results.
export function computeTerminal(
  wf,
  answers,
  aiByStep,
) {
  const byId = stepsById(wf);
  const path = [];
  const aiValues = {};
  let currentId = wf.start;

  for (let hops = 0; hops <= wf.steps.length + 1; hops++) {
    const step = byId.get(currentId);
    if (!step) throw new EngineError(`missing step "${currentId}"`);
    path.push(step.id);

    if (step.kind === 'outcome') return { terminal: step.id, path };

    if (step.kind === 'input') {
      for (const f of step.fields) {
        if (f.required && f.type !== 'image' && answers[f.id] === undefined) {
          throw new EngineError(`missing required answer "${f.id}" (step "${step.id}")`);
        }
      }
      currentId = step.next;
    } else if (step.kind === 'ai') {
      const result = aiByStep[step.id];
      if (!result) {
        // No recorded evaluation: legitimate only if the workflow defines an
        // error path (AI unreachable in the field). Fails safe toward referral.
        if (!step.onErrorStep) throw new EngineError(`no AI evaluation recorded for step "${step.id}"`);
        currentId = step.onErrorStep;
      } else {
        applyOutputs(step, result, aiValues);
        currentId = aiNextStep(step, result);
      }
    } else {
      currentId = resolveBranch(step, answers, aiValues);
    }
  }
  throw new EngineError('workflow did not reach an outcome (loop detected)');
}

export function pickText(loc, lang = 'en') {
  if (!loc) return '';
  return loc[lang] ?? Object.values(loc)[0] ?? '';
}
