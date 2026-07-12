import { stepsById } from './parse.js';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FIELD_TYPES = new Set(['choice', 'number', 'text', 'image']);
const WHEN_OPS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in']);
const BIND_MODES = new Set(['value', 'score', 'file']);
const OUTPUT_FROM = new Set(['label', 'score', 'confidence']);
const WHEN_SOURCES = new Set(['ai', 'answers']);
const SEVERITIES = new Set(['high', 'medium', 'low', 'info']);
// Workflows may narrow these upload rules but cannot widen them.
export const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
export const MAX_IMAGE_SIZE_MB = 5;
export const MAX_WORKFLOW_STEPS = 100;
const MAX_TEXT = 400;

// Workflow text is untrusted and must remain plain text.
function checkText(errors, text, where) {
  if (text.length > MAX_TEXT) errors.push(`${where}: text longer than ${MAX_TEXT} chars`);
  if (/[<>]/.test(text) || /javascript:/i.test(text)) errors.push(`${where}: markup or script content is not allowed`);
}

function checkLocalized(errors, loc, where) {
  for (const [lang, text] of Object.entries(loc ?? {})) checkText(errors, text, `${where} (${lang})`);
}

function conditionTargets(c) {
  if ('when' in c) return [c.when];
  const group = 'all' in c ? c.all : c.any;
  return group.flatMap(conditionTargets);
}

function stepEdges(s) {
  switch (s.kind) {
    case 'input': return [s.next];
    case 'ai': return [s.next, s.lowConfidenceStep, s.onErrorStep].filter(Boolean);
    case 'branch': return [...s.cases.map((c) => c.step), s.defaultStep];
    case 'outcome': return [];
  }
}

function inspectReachableGraph(start, byId) {
  const reachable = new Set();
  const state = new Map();
  const stack = [];
  const order = [];
  const cycles = new Set();

  function visit(id) {
    if (!byId.has(id)) return;
    if (state.get(id) === 1) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id].map((stepId) => `"${stepId}"`).join(' -> ');
      cycles.add(`reachable cycle detected: ${cycle}`);
      return;
    }
    if (state.get(id) === 2) return;

    state.set(id, 1);
    reachable.add(id);
    stack.push(id);
    for (const target of stepEdges(byId.get(id))) visit(target);
    stack.pop();
    state.set(id, 2);
    order.push(id);
  }

  visit(start);
  return { reachable, order: order.reverse(), cycles: [...cycles] };
}

function availableAfter(step, available) {
  const next = new Set(available);
  if (step.kind === 'input') {
    for (const field of step.fields) next.add(`answer:${field.id}`);
  }
  return next;
}

function transitions(step, available) {
  if (step.kind === 'outcome') return [];
  if (step.kind === 'input') return [{ target: step.next, available: availableAfter(step, available) }];
  if (step.kind === 'branch') {
    return [...step.cases.map((item) => item.step), step.defaultStep]
      .map((target) => ({ target, available: new Set(available) }));
  }

  const withOutputs = new Set(available);
  for (const output of step.outputs) withOutputs.add(`ai:${output.as}`);
  const paths = [
    { target: step.next, available: new Set(withOutputs) },
    step.lowConfidenceStep && { target: step.lowConfidenceStep, available: new Set(withOutputs) },
    step.onErrorStep && { target: step.onErrorStep, available: new Set(available) },
  ];
  return paths.filter(Boolean);
}

function intersect(sets) {
  if (!sets.length) return new Set();
  const shared = new Set(sets[0]);
  for (const value of shared) {
    if (sets.some((set) => !set.has(value))) shared.delete(value);
  }
  return shared;
}

function checkDataFlow(errors, wf, byId, order, fields, aiAliases) {
  const incoming = new Map([[wf.start, [new Set()]]]);

  for (const id of order) {
    const step = byId.get(id);
    const available = intersect(incoming.get(id) ?? []);
    const where = `step "${id}"`;

    if (step.kind === 'ai') {
      for (const binding of step.inputs) {
        if (fields.has(binding.field) && !available.has(`answer:${binding.field}`)) {
          errors.push(`${where}: binds answer "${binding.field}" before it is available on every path`);
        }
      }
    }

    if (step.kind === 'branch') {
      for (const item of step.cases) {
        for (const condition of conditionTargets(item.condition)) {
          const token = `${condition.source === 'answers' ? 'answer' : 'ai'}:${condition.field}`;
          const declared = condition.source === 'answers'
            ? fields.has(condition.field)
            : aiAliases.has(condition.field);
          if (declared && !available.has(token)) {
            const kind = condition.source === 'answers' ? 'answer' : 'AI output';
            errors.push(`${where}: condition references ${kind} "${condition.field}" before it is available on every path`);
          }
        }
      }
    }

    for (const edge of transitions(step, available)) {
      if (!byId.has(edge.target)) continue;
      const states = incoming.get(edge.target) ?? [];
      states.push(edge.available);
      incoming.set(edge.target, states);
    }
  }
}

function checkField(errors, f, where) {
  if (!ID_RE.test(f.id)) errors.push(`${where}: invalid field id "${f.id}"`);
  if (!FIELD_TYPES.has(f.type)) errors.push(`${where}: unknown field type "${f.type}" (fail closed)`);
  checkLocalized(errors, f.label, `${where} label`);
  if (f.type === 'choice') {
    if (!f.options?.length) errors.push(`${where}: choice field "${f.id}" has no options`);
    const seen = new Set();
    for (const o of f.options ?? []) {
      if (seen.has(o.value)) errors.push(`${where}: duplicate option value "${o.value}"`);
      seen.add(o.value);
      checkText(errors, o.value, `${where} option value`);
      checkLocalized(errors, o.label, `${where} option label`);
      if (o.score !== undefined && !Number.isFinite(o.score)) errors.push(`${where}: option "${o.value}" score is not a number`);
    }
    if ((f.options?.length ?? 0) > 20) errors.push(`${where}: more than 20 options`);
  }
  if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.min > f.max) {
    errors.push(`${where}: number field "${f.id}" has min > max`);
  }
  if (f.type === 'number') {
    if (f.min !== undefined && !Number.isFinite(f.min)) errors.push(`${where}: number field "${f.id}" has an invalid min`);
    if (f.max !== undefined && !Number.isFinite(f.max)) errors.push(`${where}: number field "${f.id}" has an invalid max`);
  }
  if (f.type === 'image') {
    if (f.maxSizeMb !== undefined && (!Number.isFinite(f.maxSizeMb) || f.maxSizeMb <= 0 || f.maxSizeMb > MAX_IMAGE_SIZE_MB)) {
      errors.push(`${where}: image field "${f.id}" has an invalid maxSizeMb`);
    }
    for (const mime of f.accept ?? []) {
      if (!SUPPORTED_IMAGE_TYPES.has(mime)) {
        errors.push(`${where}: image field "${f.id}" accepts unsupported type "${mime}"`);
      }
    }
  }
}

export function validateWorkflow(wf, knownModels) {
  const errors = [];
  if (!ID_RE.test(wf.id)) errors.push(`invalid workflow id "${wf.id}"`);
  if (!VERSION_RE.test(wf.version)) errors.push(`workflow version "${wf.version}" is not MAJOR.MINOR.PATCH`);
  if (wf.engine !== '1') errors.push(`unsupported engine "${wf.engine}" (this renderer understands engine 1; fail closed)`);
  if (wf.steps.length > MAX_WORKFLOW_STEPS) errors.push(`more than ${MAX_WORKFLOW_STEPS} steps`);
  checkLocalized(errors, wf.meta.title, 'title');
  checkLocalized(errors, wf.meta.description, 'description');
  checkLocalized(errors, wf.meta.disclaimer, 'disclaimer');

  const byId = stepsById(wf);
  if (byId.size !== wf.steps.length) {
    const seen = new Set();
    for (const s of wf.steps) {
      if (seen.has(s.id)) errors.push(`duplicate step id "${s.id}"`);
      seen.add(s.id);
    }
  }
  if (!byId.has(wf.start)) errors.push(`start step "${wf.start}" does not exist`);
  else if (byId.get(wf.start).kind !== 'input') {
    errors.push(`start step "${wf.start}" must be an input step (engine 1)`);
  }

  // Duplicate field IDs could make consumers resolve different definitions.
  const fields = new Map();
  for (const s of wf.steps) {
    if (s.kind !== 'input') continue;
    for (const f of s.fields) {
      if (fields.has(f.id)) errors.push(`duplicate field id "${f.id}"`);
      fields.set(f.id, f);
    }
  }

  // Field IDs and AI output aliases share one namespace and must be unique
  // across the workflow (ratified contract, validation rules).
  const aiAliases = new Set();
  const nameSpace = new Set(fields.keys());
  for (const s of wf.steps) {
    if (s.kind !== 'ai') continue;
    for (const o of s.outputs) {
      if (!OUTPUT_FROM.has(o.from)) errors.push(`step "${s.id}": <output from="${o.from}"> is not label, score or confidence`);
      if (!ID_RE.test(o.as)) errors.push(`step "${s.id}": invalid output alias "${o.as}"`);
      if (nameSpace.has(o.as)) errors.push(`step "${s.id}": output alias "${o.as}" collides with a field id or another alias`);
      nameSpace.add(o.as);
      aiAliases.add(o.as);
    }
  }

  for (const s of wf.steps) {
    const where = `step "${s.id}"`;
    if (!ID_RE.test(s.id)) errors.push(`invalid step id "${s.id}"`);
    for (const target of stepEdges(s)) {
      if (!byId.has(target)) errors.push(`${where}: references missing step "${target}"`);
    }
    if (s.kind === 'input') {
      checkLocalized(errors, s.prompt, `${where} prompt`);
      checkLocalized(errors, s.help, `${where} help`);
      if (s.fields.length === 0) errors.push(`${where}: input step has no fields`);
      if (s.fields.length > 20) errors.push(`${where}: more than 20 fields`);
      for (const f of s.fields) checkField(errors, f, where);
    }
    if (s.kind === 'ai') {
      if (s.inputs.length === 0) errors.push(`${where}: ai step binds no inputs`);
      let fileBindings = 0;
      const seenAliases = new Set();
      for (const b of s.inputs) {
        // Two bindings with one alias would overwrite one model input.
        if (seenAliases.has(b.as)) errors.push(`${where}: duplicate model input alias "${b.as}"`);
        seenAliases.add(b.as);
        if (!BIND_MODES.has(b.bind)) {
          errors.push(`${where}: unknown binding mode "${b.bind}" (fail closed)`);
          continue;
        }
        const field = fields.get(b.field);
        if (!field) {
          errors.push(`${where}: binds unknown field "${b.field}"`);
          continue;
        }
        if (b.bind === 'file') {
          fileBindings += 1;
          if (field.type !== 'image') errors.push(`${where}: bind="file" may reference only an image field ("${b.field}" is ${field.type})`);
        }
        if (b.bind !== 'file' && field.required === false) {
          errors.push(`${where}: model input "${b.field}" must be required; optional model inputs are not supported in engine 1`);
        }
        if (b.bind === 'score') {
          if (field.type !== 'choice') errors.push(`${where}: bind="score" may reference only a choice field ("${b.field}" is ${field.type})`);
          else if (field.options?.some((o) => o.score === undefined)) errors.push(`${where}: bind="score" requires a score on every option of "${b.field}"`);
        }
        if (b.bind === 'value' && field.type !== 'number') {
          errors.push(`${where}: bind="value" sends a numeric answer and may reference only a number field ("${b.field}" is ${field.type})`);
        }
      }
      if (fileBindings > 1) errors.push(`${where}: engine 1 permits at most one bind="file" input per ai step`);

      // Every AI step has a complete output and fallback contract.
      for (const from of OUTPUT_FROM) {
        const count = s.outputs.filter((o) => o.from === from).length;
        if (count !== 1) errors.push(`${where}: must map "${from}" exactly once (found ${count})`);
      }
      // A malformed threshold would silently disable the low-confidence route.
      if (s.lowConfidenceBelow === undefined || !Number.isFinite(s.lowConfidenceBelow) || !s.lowConfidenceStep) {
        errors.push(`${where}: a low-confidence threshold and target step are required`);
      } else if (s.lowConfidenceBelow <= 0 || s.lowConfidenceBelow > 1) {
        errors.push(`${where}: lowConfidenceBelow must be above 0 and at most 1`);
      }
      if (!s.onErrorStep) errors.push(`${where}: onErrorStep is required`);

      // Engine 1 accepts only ^MAJOR model version constraints.
      if (!/^\^\d+$/.test(s.modelVersion)) {
        errors.push(`${where}: modelVersion must use ^MAJOR syntax (got "${s.modelVersion}")`);
      } else if (knownModels) {
        const available = knownModels.get(s.model);
        if (!available) errors.push(`${where}: unknown mock model "${s.model}"`);
        else if (available.split('.')[0] !== s.modelVersion.slice(1)) {
          errors.push(`${where}: model "${s.model}" version ${available} does not satisfy ${s.modelVersion}`);
        }
      }
    }
    if (s.kind === 'branch') {
      if (s.cases.length === 0) errors.push(`${where}: branch has no cases`);
      for (const c of s.cases) {
        for (const w of conditionTargets(c.condition)) {
          if (!WHEN_OPS.has(w.op)) errors.push(`${where}: unknown op "${w.op}"`);
          if (!WHEN_SOURCES.has(w.source)) errors.push(`${where}: unknown condition source "${w.source}" (fail closed)`);
          if (w.source === 'ai' && !aiAliases.has(w.field)) errors.push(`${where}: condition references undeclared AI output "${w.field}"`);
          if (w.source === 'answers' && !fields.has(w.field)) errors.push(`${where}: condition references unknown answer "${w.field}"`);
          checkText(errors, w.value, `${where} condition value`);
        }
      }
    }
    if (s.kind === 'outcome') {
      if (s.severity !== undefined && !SEVERITIES.has(s.severity)) {
        errors.push(`${where}: severity must be high, medium, low or info (got "${s.severity}")`);
      }
      checkText(errors, s.code, `${where} code`);
      checkLocalized(errors, s.label, `${where} label`);
      checkLocalized(errors, s.advice, `${where} advice`);
    }
  }

  // Workflows are executable graphs. Engine 1 deliberately supports a DAG,
  // not loops, and references may use only values defined on every path.
  const graph = inspectReachableGraph(wf.start, byId);
  errors.push(...graph.cycles);
  if (graph.cycles.length === 0) {
    checkDataFlow(errors, wf, byId, graph.order, fields, aiAliases);
  }

  for (const s of wf.steps) {
    if (!graph.reachable.has(s.id)) errors.push(`step "${s.id}" is unreachable from start`);
  }
  if (!wf.steps.some((s) => s.kind === 'outcome' && graph.reachable.has(s.id))) {
    errors.push('no outcome step is reachable from start');
  }

  return errors;
}
