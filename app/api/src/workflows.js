import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWorkflow, validateWorkflow } from '@screening/engine';
import { MODEL_VERSIONS, validateModelContracts } from './mock-ai.js';

// Re-read on every request: workflow files are tiny, and editing an XML then
// refreshing the browser demonstrates config-driven behaviour with no restart.
// Caching is an add-later concern recorded in limits.
export function loadWorkflows(dir) {
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.xml')).sort()) {
    const xml = readFileSync(join(dir, file), 'utf8');
    try {
      const workflow = parseWorkflow(xml);
      const errors = [
        ...validateWorkflow(workflow, MODEL_VERSIONS),
        ...validateModelContracts(workflow),
      ];
      out.push({ file, xml, workflow, errors });
    } catch (e) {
      out.push({ file, xml, errors: [e instanceof Error ? e.message : String(e)] });
    }
  }

  const filesById = new Map();
  for (const entry of out) {
    if (!entry.workflow) continue;
    const files = filesById.get(entry.workflow.id) ?? [];
    files.push(entry.file);
    filesById.set(entry.workflow.id, files);
  }
  for (const entry of out) {
    if (!entry.workflow) continue;
    const files = filesById.get(entry.workflow.id);
    if (files.length > 1) {
      entry.errors.push(`duplicate workflow id "${entry.workflow.id}" in files: ${files.join(', ')}`);
    }
  }
  return out;
}

export function findWorkflow(dir, id) {
  return loadWorkflows(dir).find((w) => w.workflow?.id === id);
}

export function defaultWorkflowsDir() {
  for (const candidate of [resolve('workflows'), resolve('../../workflows')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('workflows directory not found; set WORKFLOWS_DIR');
}
