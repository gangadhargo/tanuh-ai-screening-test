import { useMemo, useRef, useState } from 'react';
import {
  aiNextStep, collectAiValues, pickText, resolveBranch, stepsById, validateAnswer,
} from '@screening/engine';
import { ApiError, evaluate, submitOutcome } from './api.js';
import { FieldInput } from './registry.jsx';

export function Runner({ workflow, onExit }) {
  const byId = useMemo(() => stepsById(workflow), [workflow]);
  // Mint both identities before the first response can be lost.
  const ids = useRef({ encounterId: `enc-${crypto.randomUUID()}`, submissionKey: crypto.randomUUID() });

  const [answers, setAnswers] = useState({});
  const [files, setFiles] = useState({});
  const [evaluations, setEvaluations] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [stepCount, setStepCount] = useState(1);
  const startStep = byId.get(workflow.start);
  const [phase, setPhase] = useState(
    startStep?.kind === 'input'
      ? { t: 'input', step: startStep }
      : { t: 'submit-rejected', message: 'workflow must start with a question step' },
  );

  function advance(stepId, currentEvaluations) {
    const aiValues = collectAiValues(workflow, currentEvaluations);
    let current = byId.get(stepId);
    for (let hops = 0; hops < workflow.steps.length + 1 && current; hops += 1) {
      if (current.kind === 'branch') {
        current = byId.get(resolveBranch(current, answers, aiValues));
      } else if (current.kind === 'input') {
        setStepCount((count) => count + 1);
        setPhase({ t: 'input', step: current });
        return;
      } else if (current.kind === 'ai') {
        void runAi(current, currentEvaluations);
        return;
      } else {
        setPhase({ t: 'outcome', step: current });
        return;
      }
    }
    setPhase({ t: 'submit-rejected', message: 'the workflow definition did not reach an outcome' });
  }

  async function runAi(step, currentEvaluations) {
    setPhase({ t: 'ai-running', step });
    const inputs = {};
    for (const binding of step.inputs) {
      if (binding.bind !== 'file') inputs[binding.as] = answers[binding.field];
    }
    // Only the field declared with bind="file" can travel with this step.
    const fileBinding = step.inputs.find((binding) => binding.bind === 'file');
    const image = fileBinding ? files[fileBinding.field] : undefined;
    try {
      const result = await evaluate({
        encounterId: ids.current.encounterId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        stepId: step.id,
        inputs,
      }, image);
      const nextEvaluations = { ...currentEvaluations, [step.id]: result };
      setEvaluations(nextEvaluations);
      advance(aiNextStep(step, result), nextEvaluations);
    } catch (error) {
      const message = error instanceof ApiError && error.status === 409
        ? 'This screening was updated on the server. Please start again from the list.'
        : 'The screening check could not be reached.';
      setPhase({ t: 'ai-error', step, message });
    }
  }

  function continueFromInput(step) {
    const errors = {};
    for (const field of step.fields) {
      const value = field.type === 'image' ? undefined : answers[field.id];
      if (field.type === 'image') {
        if (field.required && !files[field.id]) errors[field.id] = 'A photo is required';
        continue;
      }
      if (value === undefined || value === '') {
        if (field.required) errors[field.id] = 'This answer is required';
        continue;
      }
      const error = validateAnswer(field, value);
      if (error) errors[field.id] = error;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length === 0) advance(step.next, evaluations);
  }

  async function submit(step) {
    setPhase({ t: 'submitting', step });
    const cleanAnswers = { ...answers };
    try {
      const result = await submitOutcome({
        encounterId: ids.current.encounterId,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        finalStepId: step.id,
        answers: cleanAnswers,
        evaluationIds: Object.values(evaluations).map((evaluation) => evaluation.evaluationId),
      }, ids.current.submissionKey);

      if (result.status === 201 || result.status === 200) {
        setPhase({
          t: 'receipt',
          outcomeLabel: result.body.outcomeLabel ?? pickText(step.label),
          outcomeId: result.body.outcomeId ?? '',
          replayed: Boolean(result.body.replayed),
        });
      } else {
        const detail = result.body.detail ? `: ${result.body.detail}` : '';
        setPhase({ t: 'submit-rejected', message: `${result.body.error ?? 'rejected'}${detail}` });
      }
    } catch {
      setPhase({
        t: 'submit-retry',
        step,
        message: 'No connection. Your answers remain on this page. Keep it open and retry when the signal returns.',
      });
    }
  }

  const disclaimer = pickText(workflow.meta.disclaimer);

  return (
    <div className="runner">
      <header className="runner-header">
        <button type="button" className="link" onClick={onExit}>← All screenings</button>
        <h1>{pickText(workflow.meta.title)}</h1>
        <span className="chip">Step {stepCount}</span>
      </header>

      {phase.t === 'input' && (
        <section className="card">
          <h2>{pickText(phase.step.prompt)}</h2>
          {phase.step.help && <p className="help">{pickText(phase.step.help)}</p>}
          {phase.step.fields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={answers[field.id]}
              file={files[field.id]}
              error={fieldErrors[field.id]}
              onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
              onFile={(file) => setFiles((current) => {
                const next = { ...current };
                if (file) next[field.id] = file;
                else delete next[field.id];
                return next;
              })}
            />
          ))}
          <button type="button" className="primary" onClick={() => continueFromInput(phase.step)}>Continue</button>
        </section>
      )}

      {phase.t === 'ai-running' && (
        <section className="card center" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <h2>{pickText(phase.step.prompt) || 'Running screening check…'}</h2>
          <p className="help">Needs a signal for a moment. This can be slow on a weak connection.</p>
        </section>
      )}

      {phase.t === 'ai-error' && (
        <section className="card" role="alert">
          <h2>Screening check unavailable</h2>
          <p>{phase.message}</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void runAi(phase.step, evaluations)}>Try again</button>
            {phase.step.onErrorStep && (
              <button type="button" className="secondary" onClick={() => advance(phase.step.onErrorStep, evaluations)}>
                Continue without the check
              </button>
            )}
          </div>
        </section>
      )}

      {(phase.t === 'outcome' || phase.t === 'submitting' || phase.t === 'submit-retry') && (
        <section className="card">
          <div className={`severity ${phase.step.severity ?? 'info'}`}>
            {pickText(phase.step.label)}
          </div>
          {phase.step.advice && <p>{pickText(phase.step.advice)}</p>}
          {phase.t === 'submit-retry' && <p className="field-error" role="alert">{phase.message}</p>}
          <button
            type="button"
            className="primary"
            disabled={phase.t === 'submitting'}
            onClick={() => void submit(phase.step)}
          >
            {phase.t === 'submitting' ? 'Saving…' : phase.t === 'submit-retry' ? 'Retry saving' : 'Save screening result'}
          </button>
        </section>
      )}

      {phase.t === 'receipt' && (
        <section className="card center">
          <div className="receipt-tick" aria-hidden="true">✓</div>
          <h2>Screening saved</h2>
          <p>{phase.outcomeLabel}</p>
          {phase.replayed && <p className="help">This was already saved earlier. No duplicate was created.</p>}
          <p className="receipt-id">Reference: {phase.outcomeId}</p>
          <button type="button" className="primary" onClick={onExit}>Start another screening</button>
        </section>
      )}

      {phase.t === 'submit-rejected' && (
        <section className="card" role="alert">
          <h2>Could not save this screening</h2>
          <p>{phase.message}</p>
          <button type="button" className="secondary" onClick={onExit}>Back to screenings</button>
        </section>
      )}

      {disclaimer && <footer className="disclaimer">{disclaimer}</footer>}
    </div>
  );
}
