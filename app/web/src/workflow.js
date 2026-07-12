import { parseWorkflow, validateWorkflow } from '@screening/engine';

export function parseValidatedWorkflow(xml) {
  const workflow = parseWorkflow(xml);
  const errors = validateWorkflow(workflow);

  if (errors.length > 0) {
    throw new Error(`Invalid workflow: ${errors.join('; ')}`);
  }

  return workflow;
}
