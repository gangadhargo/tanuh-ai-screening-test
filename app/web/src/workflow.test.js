import { describe, expect, it } from 'vitest';
import { parseValidatedWorkflow } from './workflow.js';

describe('browser workflow boundary', () => {
  it('refuses a workflow for a newer engine before rendering it', () => {
    const xml = `<?xml version="1.0"?>
      <workflow id="future" version="1.0.0" engine="2">
        <metadata><title lang="en">Future workflow</title></metadata>
        <steps start="question">
          <input-step id="question">
            <prompt lang="en">Reading</prompt>
            <field id="reading" type="number"/>
            <next step="done"/>
          </input-step>
          <outcome-step id="done" code="done">
            <label lang="en">Done</label>
          </outcome-step>
        </steps>
      </workflow>`;

    expect(() => parseValidatedWorkflow(xml)).toThrow('unsupported engine "2"');
  });
});
