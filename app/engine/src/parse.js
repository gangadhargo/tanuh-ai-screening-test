import { XMLParser } from 'fast-xml-parser';
import { WorkflowParseError } from './types.js';

const ALWAYS_ARRAY = new Set([
  'input-step', 'ai-step', 'branch-step', 'outcome-step',
  'field', 'option', 'case', 'when', 'all', 'any', 'input', 'output', 'param',
  'reference', 'title', 'description', 'disclaimer', 'prompt', 'help', 'label', 'advice',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

function attr(node, name) {
  const v = node[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

function requireAttr(node, name, where) {
  const v = attr(node, name);
  if (v === undefined || v === '') throw new WorkflowParseError(`missing attribute "${name}" on ${where}`);
  return v;
}

// Unknown attributes or child elements anywhere in the document fail closed.
function checkShape(node, where, allowedAttrs, allowedChildren, textAllowed = false) {
  for (const key of Object.keys(node)) {
    if (key === '#text') {
      if (!textAllowed) throw new WorkflowParseError(`unexpected text content in ${where}`);
      continue;
    }
    if (key.startsWith('@_')) {
      const name = key.slice(2);
      if (!allowedAttrs.includes(name)) throw new WorkflowParseError(`unknown attribute "${name}" on ${where} (fail closed)`);
      continue;
    }
    if (!allowedChildren.includes(key)) throw new WorkflowParseError(`unknown element <${key}> in ${where} (fail closed)`);
  }
}

function localized(nodes, where) {
  const out = {};
  for (const n of nodes ?? []) {
    if (typeof n === 'string') { out.en = n; continue; }
    checkShape(n, where, ['lang'], [], true);
    const lang = attr(n, 'lang') ?? 'en';
    out[lang] = String(n['#text'] ?? '');
  }
  if (Object.keys(out).length === 0) throw new WorkflowParseError(`missing localized text for ${where}`);
  return out;
}

function optionalLocalized(nodes, where) {
  return nodes === undefined ? undefined : localized(nodes, where);
}

function num(node, name) {
  const v = attr(node, name);
  if (v === undefined) return undefined;
  return v.trim() === '' ? Number.NaN : Number(v);
}

function parseField(node, stepId) {
  const id = requireAttr(node, 'id', `field in step "${stepId}"`);
  checkShape(node, `field "${id}"`, ['id', 'type', 'required', 'min', 'max', 'unit', 'accept', 'maxSizeMb'], ['label', 'option']);
  const type = requireAttr(node, 'type', `field "${id}"`);
  const options = node.option?.map((o) => {
    checkShape(o, `option of field "${id}"`, ['value', 'score'], ['label']);
    return {
      value: requireAttr(o, 'value', `option of field "${id}"`),
      score: num(o, 'score'),
      label: localized(o.label, `option label of field "${id}"`),
    };
  });
  return {
    id,
    type,
    required: attr(node, 'required') !== 'false',
    label: optionalLocalized(node.label, `label of field "${id}"`),
    min: num(node, 'min'),
    max: num(node, 'max'),
    unit: attr(node, 'unit'),
    accept: attr(node, 'accept')?.split(',').map((s) => s.trim()),
    maxSizeMb: num(node, 'maxSizeMb'),
    options,
  };
}

function nextOf(node, stepId) {
  const next = node.next;
  const n = Array.isArray(next) ? next[0] : next;
  if (!n) throw new WorkflowParseError(`step "${stepId}" has no <next>`);
  checkShape(n, `<next> of step "${stepId}"`, ['step'], []);
  return requireAttr(n, 'step', `<next> of step "${stepId}"`);
}

function parseWhen(node, where) {
  checkShape(node, `<when> in ${where}`, ['source', 'field', 'op', 'value'], []);
  return {
    source: requireAttr(node, 'source', `<when> in ${where}`),
    field: requireAttr(node, 'field', `<when> in ${where}`),
    op: requireAttr(node, 'op', `<when> in ${where}`),
    value: requireAttr(node, 'value', `<when> in ${where}`),
  };
}

function parseConditionGroup(node, where) {
  const out = [];
  for (const w of node.when ?? []) out.push({ when: parseWhen(w, where) });
  for (const a of node.all ?? []) {
    checkShape(a, `<all> in ${where}`, [], ['when', 'all', 'any']);
    const conditions = parseConditionGroup(a, where);
    if (conditions.length === 0) throw new WorkflowParseError(`<all> in ${where} must contain a condition`);
    out.push({ all: conditions });
  }
  for (const a of node.any ?? []) {
    checkShape(a, `<any> in ${where}`, [], ['when', 'all', 'any']);
    const conditions = parseConditionGroup(a, where);
    if (conditions.length === 0) throw new WorkflowParseError(`<any> in ${where} must contain a condition`);
    out.push({ any: conditions });
  }
  return out;
}

function parseCase(node, stepId) {
  checkShape(node, `<case> in branch "${stepId}"`, ['step'], ['when', 'all', 'any']);
  const step = requireAttr(node, 'step', `<case> in branch "${stepId}"`);
  const conditions = parseConditionGroup(node, `branch "${stepId}"`);
  if (conditions.length === 0) throw new WorkflowParseError(`<case> in branch "${stepId}" has no conditions`);
  return { step, condition: conditions.length === 1 ? conditions[0] : { all: conditions } };
}

export function parseWorkflow(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    throw new WorkflowParseError(`malformed XML: ${e.message}`);
  }
  const wf = doc.workflow;
  if (!wf) throw new WorkflowParseError('missing <workflow> root element');
  checkShape(wf, '<workflow>', ['id', 'version', 'engine'], ['metadata', 'steps']);

  const meta = Array.isArray(wf.metadata) ? wf.metadata[0] : wf.metadata;
  if (!meta) throw new WorkflowParseError('missing <metadata>');
  checkShape(meta, '<metadata>', [], ['title', 'description', 'disclaimer', 'reference']);

  const stepsNode = Array.isArray(wf.steps) ? wf.steps[0] : wf.steps;
  if (!stepsNode) throw new WorkflowParseError('missing <steps>');
  checkShape(stepsNode, '<steps>', ['start'], ['input-step', 'ai-step', 'branch-step', 'outcome-step']);

  const steps = [];

  for (const n of stepsNode['input-step'] ?? []) {
    const id = requireAttr(n, 'id', '<input-step>');
    checkShape(n, `input-step "${id}"`, ['id'], ['prompt', 'help', 'field', 'next']);
    steps.push({
      kind: 'input',
      id,
      prompt: localized(n.prompt, `prompt of step "${id}"`),
      help: optionalLocalized(n.help, `help of step "${id}"`),
      fields: (n.field ?? []).map((f) => parseField(f, id)),
      next: nextOf(n, id),
    });
  }

  for (const n of stepsNode['ai-step'] ?? []) {
    const id = requireAttr(n, 'id', '<ai-step>');
    checkShape(n, `ai-step "${id}"`,
      ['id', 'model', 'modelVersion', 'lowConfidenceBelow', 'lowConfidenceStep', 'onErrorStep'],
      ['prompt', 'input', 'output', 'param', 'next']);
    steps.push({
      kind: 'ai',
      id,
      prompt: optionalLocalized(n.prompt, `prompt of step "${id}"`),
      model: requireAttr(n, 'model', `ai-step "${id}"`),
      modelVersion: requireAttr(n, 'modelVersion', `ai-step "${id}"`),
      inputs: (n.input ?? []).map((i) => {
        checkShape(i, `<input> of ai-step "${id}"`, ['field', 'as', 'bind'], []);
        return {
          field: requireAttr(i, 'field', `<input> of ai-step "${id}"`),
          as: requireAttr(i, 'as', `<input> of ai-step "${id}"`),
          bind: attr(i, 'bind') ?? 'value',
        };
      }),
      outputs: (n.output ?? []).map((o) => {
        checkShape(o, `<output> of ai-step "${id}"`, ['from', 'as'], []);
        return {
          from: requireAttr(o, 'from', `<output> of ai-step "${id}"`),
          as: requireAttr(o, 'as', `<output> of ai-step "${id}"`),
        };
      }),
      params: (n.param ?? []).reduce((params, p) => {
        checkShape(p, `<param> of ai-step "${id}"`, ['name', 'value'], []);
        const name = requireAttr(p, 'name', `<param> of ai-step "${id}"`);
        // Duplicates would silently collapse into one model parameter.
        if (params[name] !== undefined) throw new WorkflowParseError(`duplicate <param name="${name}"> on ai-step "${id}"`);
        params[name] = requireAttr(p, 'value', `<param> of ai-step "${id}"`);
        return params;
      }, {}),
      lowConfidenceBelow: num(n, 'lowConfidenceBelow'),
      lowConfidenceStep: attr(n, 'lowConfidenceStep'),
      onErrorStep: attr(n, 'onErrorStep'),
      next: nextOf(n, id),
    });
  }

  for (const n of stepsNode['branch-step'] ?? []) {
    const id = requireAttr(n, 'id', '<branch-step>');
    checkShape(n, `branch-step "${id}"`, ['id'], ['case', 'default']);
    const def = Array.isArray(n.default) ? n.default[0] : n.default;
    if (!def) throw new WorkflowParseError(`branch "${id}" has no <default>`);
    checkShape(def, `<default> of branch "${id}"`, ['step'], []);
    steps.push({
      kind: 'branch',
      id,
      cases: (n.case ?? []).map((c) => parseCase(c, id)),
      defaultStep: requireAttr(def, 'step', `<default> of branch "${id}"`),
    });
  }

  for (const n of stepsNode['outcome-step'] ?? []) {
    const id = requireAttr(n, 'id', '<outcome-step>');
    checkShape(n, `outcome-step "${id}"`, ['id', 'code', 'severity'], ['label', 'advice']);
    steps.push({
      kind: 'outcome',
      id,
      code: requireAttr(n, 'code', `outcome "${id}"`),
      severity: attr(n, 'severity'),
      label: localized(n.label, `label of outcome "${id}"`),
      advice: optionalLocalized(n.advice, `advice of outcome "${id}"`),
    });
  }

  return {
    id: requireAttr(wf, 'id', '<workflow>'),
    version: requireAttr(wf, 'version', '<workflow>'),
    engine: requireAttr(wf, 'engine', '<workflow>'),
    meta: {
      title: localized(meta.title, '<title>'),
      description: optionalLocalized(meta.description, '<description>'),
      disclaimer: optionalLocalized(meta.disclaimer, '<disclaimer>'),
      references: (meta.reference ?? []).map((r) => {
        checkShape(r, '<reference>', ['href', 'label'], []);
        return {
          href: requireAttr(r, 'href', '<reference>'),
          label: requireAttr(r, 'label', '<reference>'),
        };
      }),
    },
    start: requireAttr(stepsNode, 'start', '<steps>'),
    steps,
  };
}

export function stepsById(wf) {
  return new Map(wf.steps.map((s) => [s.id, s]));
}
