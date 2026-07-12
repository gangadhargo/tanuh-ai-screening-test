import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeTerminal, parseWorkflow, validateWorkflow, EngineError } from '../src/index.js';

const load = (file) =>
  parseWorkflow(readFileSync(fileURLToPath(new URL(`../../../workflows/${file}`, import.meta.url)), 'utf8'));

const ai = (label, confidence = 0.9) =>
  ({ label, score: 0.5, confidence, modelVersion: 'test' });

describe('sample workflows', () => {
  it('both parse and pass validation', () => {
    for (const file of ['anemia-screening.xml', 'questionnaire-risk-screening.xml']) {
      expect(validateWorkflow(load(file))).toEqual([]);
    }
  });
});

describe('branching and workflow-defined fallbacks', () => {
  const wf = load('anemia-screening.xml');
  const qwf = load('questionnaire-risk-screening.xml');

  it('severe label goes to urgent referral', () => {
    const { terminal } = computeTerminal(wf, { haemoglobin: 6 }, { 'anemia-ai': ai('severe') });
    expect(terminal).toBe('urgent-referral');
  });

  it('below-threshold reading routes to ANC referral', () => {
    const { terminal } = computeTerminal(wf, { haemoglobin: 9 }, { 'anemia-ai': ai('moderate') });
    expect(terminal).toBe('anc-referral');
  });

  it('combines an answer AND the AI result (questionnaire tobacco case)', () => {
    const answers = {
      age: '30-39', tobacco: 'daily', alcohol: 'no',
      waist: 'band-0', activity: 'active', familyHistory: 'no',
    };
    const { terminal } = computeTerminal(qwf, answers, { 'ncd-risk-ai': ai('low-risk') });
    expect(terminal).toBe('counsel-tobacco');
  });

  it('low confidence follows the workflow redirect', () => {
    const { terminal } = computeTerminal(wf, { haemoglobin: 10.9 }, { 'anemia-ai': ai('moderate', 0.4) });
    expect(terminal).toBe('retest-advice');
  });

  it('missing AI evaluation follows the error path', () => {
    const { terminal } = computeTerminal(wf, { haemoglobin: 9 }, {});
    expect(terminal).toBe('manual-referral');
  });

  it('missing required answer is refused', () => {
    expect(() => computeTerminal(wf, {}, { 'anemia-ai': ai('moderate') }))
      .toThrow(EngineError);
  });

  it('supports two AI steps in sequence (no one-AI-step assumption)', () => {
    const twoAi = parseWorkflow(`<?xml version="1.0"?>
      <workflow id="t" version="1.0.0" engine="1">
        <metadata><title lang="en">T</title></metadata>
        <steps start="s1">
          <input-step id="s1"><prompt lang="en">Q</prompt>
            <field id="a" type="number"/><next step="first"/></input-step>
          <ai-step id="first" model="threshold-bands" modelVersion="^1" onErrorStep="end"
                   lowConfidenceBelow="0.5" lowConfidenceStep="end">
            <input field="a" as="value" bind="value"/>
            <output from="label" as="firstBand"/><output from="score" as="s1s"/><output from="confidence" as="s1c"/>
            <next step="second"/></ai-step>
          <ai-step id="second" model="threshold-bands" modelVersion="^1" onErrorStep="end"
                   lowConfidenceBelow="0.5" lowConfidenceStep="end">
            <input field="a" as="value" bind="value"/>
            <output from="label" as="secondBand"/><output from="score" as="s2s"/><output from="confidence" as="s2c"/>
            <next step="route"/></ai-step>
          <branch-step id="route">
            <case step="both"><all>
              <when source="ai" field="firstBand" op="eq" value="severe"/>
              <when source="ai" field="secondBand" op="eq" value="moderate"/>
            </all></case>
            <default step="end"/></branch-step>
          <outcome-step id="both" code="both"><label lang="en">Both</label></outcome-step>
          <outcome-step id="end" code="end"><label lang="en">End</label></outcome-step>
        </steps>
      </workflow>`);
    expect(validateWorkflow(twoAi)).toEqual([]);
    const { terminal } = computeTerminal(twoAi, { a: 5 }, { first: ai('severe'), second: ai('moderate') });
    expect(terminal).toBe('both');
  });
});

describe('validator (workflow is untrusted data)', () => {
  const xml = (steps) => `<?xml version="1.0"?>
    <workflow id="t" version="1.0.0" engine="1">
      <metadata><title lang="en">T</title></metadata>
      <steps start="s1">${steps}</steps>
    </workflow>`;

  it('rejects broken step references', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="missing"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    const errors = validateWorkflow(wf);
    expect(errors.join(' ')).toContain('missing step');
    expect(errors.join(' ')).toContain('unreachable');
  });

  it('rejects a reachable cycle', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="route"/></input-step>
      <branch-step id="route">
        <case step="end"><when source="answers" field="a" op="eq" value="1"/></case>
        <default step="s1"/></branch-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('reachable cycle detected');
  });

  it('rejects an AI binding to a field collected later', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end"
               lowConfidenceBelow="0.5" lowConfidenceStep="end">
        <input field="future" as="value" bind="value"/>
        <output from="label" as="band"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <next step="later"/></ai-step>
      <input-step id="later"><prompt lang="en">Later</prompt>
        <field id="future" type="number"/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('binds answer "future" before it is available on every path');
  });

  it('rejects an AI binding collected on only one incoming path', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="split"/></input-step>
      <branch-step id="split">
        <case step="collect"><when source="answers" field="a" op="eq" value="1"/></case>
        <default step="check"/></branch-step>
      <input-step id="collect"><prompt lang="en">Conditional</prompt>
        <field id="sometimes" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end"
               lowConfidenceBelow="0.5" lowConfidenceStep="end">
        <input field="sometimes" as="value" bind="value"/>
        <output from="label" as="band"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('binds answer "sometimes" before it is available on every path');
  });

  it('rejects an optional field used as a required model input', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="maybe" type="number" required="false"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end"
               lowConfidenceBelow="0.5" lowConfidenceStep="end">
        <input field="maybe" as="value" bind="value"/>
        <output from="label" as="band"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('optional model inputs are not supported');
  });

  it('rejects a branch that reads an AI alias before its producer', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="premature"/></input-step>
      <branch-step id="premature">
        <case step="end"><when source="ai" field="futureBand" op="eq" value="severe"/></case>
        <default step="producer"/></branch-step>
      <ai-step id="producer" model="threshold-bands" modelVersion="^1" onErrorStep="end"
               lowConfidenceBelow="0.5" lowConfidenceStep="end">
        <input field="a" as="value" bind="value"/>
        <output from="label" as="futureBand"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('AI output "futureBand" before it is available on every path');
  });

  it('rejects markup smuggled into labels', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q &lt;img src=x onerror=alert(1)&gt;</prompt>
        <field id="a" type="number"/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('markup');
  });

  it('rejects empty condition groups', () => {
    expect(() => parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="route"/></input-step>
      <branch-step id="route">
        <case step="end"><all/></case>
        <default step="end"/></branch-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`)))
      .toThrow('must contain a condition');
  });

  it('rejects branch conditions on undeclared AI outputs', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end">
        <input field="a" as="value" bind="value"/>
        <output from="label" as="band"/>
        <next step="route"/></ai-step>
      <branch-step id="route">
        <case step="end"><when source="ai" field="ghost" op="eq" value="x"/></case>
        <default step="end"/></branch-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('undeclared AI output "ghost"');
  });

  it('rejects an output alias that collides with a field id', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end">
        <input field="a" as="value" bind="value"/>
        <output from="label" as="a"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('collides');
  });

  it('fails closed on unknown field types', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="signature"/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('unknown field type');
  });

  it('rejects duplicate field ids across steps', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q1</prompt>
        <field id="a" type="number"/><next step="s2"/></input-step>
      <input-step id="s2"><prompt lang="en">Q2</prompt>
        <field id="a" type="number"/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('duplicate field id "a"');
  });

  it('fails closed on unknown step elements', () => {
    expect(() => parseWorkflow(xml(`
      <mystery-step id="s1"/>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`)))
      .toThrow('unknown element <mystery-step> in <steps>');
  });

  it('rejects unknown condition sources', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="route"/></input-step>
      <branch-step id="route">
        <case step="end"><when source="wizard" field="a" op="eq" value="1"/></case>
        <default step="end"/></branch-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('unknown condition source "wizard"');
  });

  it('requires complete AI step declarations', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1">
        <input field="a" as="value" bind="value"/>
        <output from="label" as="band"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    const joined = validateWorkflow(wf).join(' ');
    expect(joined).toContain('must map "score" exactly once');
    expect(joined).toContain('low-confidence threshold and target');
    expect(joined).toContain('onErrorStep is required');
  });

  it('rejects malformed low-confidence thresholds', () => {
    const make = (threshold) => parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end"
               lowConfidenceBelow="${threshold}" lowConfidenceStep="end">
        <input field="a" as="value" bind="value"/>
        <output from="label" as="band"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(make('not-a-number')).join(' ')).toContain('low-confidence threshold');
    expect(validateWorkflow(make('')).join(' ')).toContain('low-confidence threshold');
  });

  it('accepts only ^MAJOR model version constraints', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="999.0.0" onErrorStep="end"
               lowConfidenceBelow="0.5" lowConfidenceStep="end">
        <input field="a" as="value" bind="value"/>
        <output from="label" as="band"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('^MAJOR');
  });

  it('requires the start step to be an input step', () => {
    const wf = parseWorkflow(`<?xml version="1.0"?>
      <workflow id="t" version="1.0.0" engine="1">
        <metadata><title lang="en">T</title></metadata>
        <steps start="end">
          <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>
        </steps>
      </workflow>`);
    expect(validateWorkflow(wf).join(' ')).toContain('must be an input step');
  });

  it('fails closed on unknown attributes and nested elements', () => {
    expect(() => parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number" foo="1"/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`)))
      .toThrow('unknown attribute "foo"');
    expect(() => parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><magic/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`)))
      .toThrow('unknown element <magic>');
  });

  it('rejects unknown severities, duplicate aliases and duplicate params', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end"
               lowConfidenceBelow="0.5" lowConfidenceStep="end">
        <input field="a" as="value" bind="value"/>
        <input field="a" as="value" bind="value"/>
        <output from="label" as="band"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done" severity="catastrophic"><label lang="en">Done</label></outcome-step>`));
    const joined = validateWorkflow(wf).join(' ');
    expect(joined).toContain('duplicate model input alias "value"');
    expect(joined).toContain('severity must be high, medium, low or info');

    expect(() => parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="a" type="number"/><next step="check"/></input-step>
      <ai-step id="check" model="threshold-bands" modelVersion="^1" onErrorStep="end"
               lowConfidenceBelow="0.5" lowConfidenceStep="end">
        <input field="a" as="value" bind="value"/>
        <output from="label" as="band"/><output from="score" as="sc"/><output from="confidence" as="cf"/>
        <param name="cutoff" value="1"/><param name="cutoff" value="2"/>
        <next step="end"/></ai-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`)))
      .toThrow('duplicate <param name="cutoff">');
  });

  it('rejects image fields that widen upload rules', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="pic" type="image" required="false" accept="image/svg+xml" maxSizeMb="6"/>
        <field id="a" type="number"/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    const joined = validateWorkflow(wf).join(' ');
    expect(joined).toContain('unsupported type "image/svg+xml"');
    expect(joined).toContain('invalid maxSizeMb');
  });

  it('rejects non-numeric number bounds', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="reading" type="number" min="unknown"/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    expect(validateWorkflow(wf).join(' ')).toContain('invalid min');
  });

  it('does not turn blank numeric attributes into zero', () => {
    const wf = parseWorkflow(xml(`
      <input-step id="s1"><prompt lang="en">Q</prompt>
        <field id="choice" type="choice">
          <option value="yes" score=""><label lang="en">Yes</label></option>
        </field>
        <field id="reading" type="number" min=""/><next step="end"/></input-step>
      <outcome-step id="end" code="done"><label lang="en">Done</label></outcome-step>`));
    const errors = validateWorkflow(wf).join(' ');
    expect(errors).toContain('score is not a number');
    expect(errors).toContain('invalid min');
  });
});
