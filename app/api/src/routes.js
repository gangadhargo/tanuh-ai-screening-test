import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  computeTerminal, pickText, stepsById, validateAnswer, validateAnswers,
  EngineError, MAX_IMAGE_SIZE_MB, MAX_WORKFLOW_STEPS, SUPPORTED_IMAGE_TYPES,
} from '@screening/engine';
import { MODELS, MockAiError, validateModelResult } from './mock-ai.js';
import { loadWorkflows, findWorkflow } from './workflows.js';
import { payloadHash, stableStringify } from './canonical.js';

const idish = z.string().min(1).max(100);
const answerValue = z.union([z.string().max(400), z.number().finite()]);

const EvalReq = z.object({
  encounterId: idish,
  workflowId: idish,
  workflowVersion: idish,
  stepId: idish,
  inputs: z.record(answerValue),
});

const OutcomeReq = z.object({
  encounterId: idish,
  workflowId: idish,
  workflowVersion: idish,
  finalStepId: idish,
  answers: z.record(answerValue),
  evaluationIds: z.array(idish).max(MAX_WORKFLOW_STEPS).default([]),
  workerRef: idish.optional(),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_SIZE_MB * 1024 * 1024 },
}).single('image');

function fieldById(wf, id) {
  for (const s of wf.steps) {
    if (s.kind === 'input') {
      const f = s.fields.find((x) => x.id === id);
      if (f) return f;
    }
  }
  return undefined;
}

// The same mapping runs at evaluation and submission. Scores always come from
// the trusted XML options.
function mapModelInputs(
  wf,
  aiStep,
  valueFor,
) {
  const inputs = {};
  let fileField;
  for (const binding of aiStep.inputs) {
    const field = fieldById(wf, binding.field);
    if (!field) return { ok: false, status: 500, body: { error: 'workflow-binding-broken', field: binding.field } };
    if (binding.bind === 'file') {
      fileField = field;
      continue;
    }
    const rawValue = valueFor(binding);
    if (rawValue === undefined) return { ok: false, status: 400, body: { error: 'missing-input', input: binding.as } };
    const answerError = validateAnswer(field, rawValue);
    if (answerError) return { ok: false, status: 400, body: { error: 'invalid-input', detail: answerError } };
    if (binding.bind === 'score') {
      const option = field.options?.find((o) => o.value === String(rawValue));
      if (option?.score === undefined) return { ok: false, status: 400, body: { error: 'option-has-no-score', input: binding.as } };
      inputs[binding.as] = option.score;
    } else {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) return { ok: false, status: 400, body: { error: 'input-not-numeric', input: binding.as } };
      inputs[binding.as] = n;
    }
  }
  return { ok: true, inputs, fileField };
}

// Every route rechecks the workflow because the browser is outside the trust boundary.
function loadValidWorkflow(dir, id, version, res) {
  const entry = findWorkflow(dir, id);
  if (!entry?.workflow) {
    res.status(404).json({ error: 'workflow-not-found' });
    return undefined;
  }
  if (entry.errors.length) {
    res.status(500).json({ error: 'workflow-failed-validation', details: entry.errors });
    return undefined;
  }
  if (entry.workflow.version !== version) {
    // Never upgrade an in-flight encounter silently.
    res.status(409).json({ error: 'workflow-version-mismatch', activeVersion: entry.workflow.version });
    return undefined;
  }
  return entry.workflow;
}

export function createApp(db, workflowsDir) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Minimal structured request log. Never logs answers or clinical values.
  app.use((req, res, next) => {
    if (req.path === '/health') {
      next();
      return;
    }
    const started = Date.now();
    res.on('finish', () => {
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      }));
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/v1/workflows', (_req, res) => {
    const items = loadWorkflows(workflowsDir)
      .filter((w) => w.workflow && w.errors.length === 0)
      .map((w) => ({
        id: w.workflow.id,
        version: w.workflow.version,
        title: w.workflow.meta.title,
        description: w.workflow.meta.description,
        availableLanguages: Object.keys(w.workflow.meta.title),
      }));
    res.set('Cache-Control', 'no-store').json(items);
  });

  app.get('/api/v1/workflows/:id', (req, res) => {
    const entry = findWorkflow(workflowsDir, req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'workflow-not-found' });
      return;
    }
    if (entry.errors.length) {
      res.status(500).json({ error: 'workflow-failed-validation', details: entry.errors });
      return;
    }
    res.set('Cache-Control', 'no-store')
      .set('X-Workflow-Version', entry.workflow.version)
      .type('application/xml')
      .send(entry.xml);
  });

  app.post('/api/v1/ai/evaluations', (req, res, next) => {
    if (req.is('multipart/form-data')) upload(req, res, next);
    else next();
  }, (req, res) => {
    let raw = req.body;
    if (req.is('multipart/form-data')) {
      try {
        raw = JSON.parse(req.body.metadata ?? '');
      } catch {
        res.status(400).json({ error: 'invalid-metadata-json' });
        return;
      }
    }
    const parsed = EvalReq.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid-request', details: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const body = parsed.data;
    const wf = loadValidWorkflow(workflowsDir, body.workflowId, body.workflowVersion, res);
    if (!wf) return;

    const step = stepsById(wf).get(body.stepId);
    if (!step || step.kind !== 'ai') {
      res.status(400).json({ error: 'not-an-ai-step' });
      return;
    }
    const aiStep = step;

    const mapped = mapModelInputs(wf, aiStep, (b) => body.inputs[b.as]);
    if (!mapped.ok) {
      res.status(mapped.status).json(mapped.body);
      return;
    }
    const modelInputs = mapped.inputs;
    const fileBinding = mapped.fileField ? { field: mapped.fileField } : undefined;

    // Ratified contract: a file is accepted only when this step declares
    // bind="file", and the referenced field's own rules apply.
    if (req.file && !fileBinding) {
      res.status(400).json({ error: 'unsolicited-file', detail: 'this AI step declares no file input' });
      return;
    }
    if (fileBinding && !req.file && fileBinding.field.required) {
      res.status(400).json({ error: 'missing-required-image', input: fileBinding.field.id });
      return;
    }
    let imageSha;
    let imageBytes;
    if (req.file && fileBinding) {
      const allowed = fileBinding.field.accept ?? [...SUPPORTED_IMAGE_TYPES];
      if (!allowed.includes(req.file.mimetype)) {
        res.status(400).json({ error: 'unsupported-image-type', allowed });
        return;
      }
      const cap = (fileBinding.field.maxSizeMb ?? 5) * 1024 * 1024;
      if (req.file.size > cap) {
        res.status(400).json({ error: 'image-too-large', maxSizeMb: fileBinding.field.maxSizeMb ?? 5 });
        return;
      }
      imageSha = createHash('sha256').update(req.file.buffer).digest('hex');
      imageBytes = req.file.size;
    }

    const model = MODELS.get(aiStep.model);
    if (!model) {
      res.status(500).json({ error: 'unknown-model', model: aiStep.model });
      return;
    }
    let result;
    try {
      result = model.run(modelInputs, aiStep.params);
      const resultErrors = validateModelResult(aiStep, result);
      if (resultErrors.length) {
        throw new MockAiError(`invalid model result: ${resultErrors.join('; ')}`);
      }
    } catch (e) {
      const message = e instanceof MockAiError ? e.message : 'evaluation failed';
      res.status(500).json({ error: 'ai-error', detail: message });
      return;
    }

    const evaluationId = `eval-${randomUUID()}`;
    db.prepare(`INSERT INTO ai_evaluations
      (id, encounter_id, workflow_id, workflow_version, step_id, model, model_version,
       inputs_json, label, score, confidence, image_sha256, image_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evaluationId, body.encounterId, wf.id, wf.version, aiStep.id, aiStep.model,
        result.modelVersion, JSON.stringify(modelInputs), result.label, result.score,
        result.confidence, imageSha ?? null, imageBytes ?? null, new Date().toISOString());

    res.status(201).json({ evaluationId, ...result, imageReceived: Boolean(req.file) });
  });

  app.post('/api/v1/outcomes', (req, res) => {
    const key = req.get('Idempotency-Key');
    if (!key || key.length < 8 || key.length > 100) {
      res.status(400).json({ error: 'idempotency-key-required', detail: 'send an Idempotency-Key header of 8-100 chars' });
      return;
    }
    const parsed = OutcomeReq.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid-request', details: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const body = parsed.data;
    const hash = payloadHash(body);

    const prior = db.prepare('SELECT payload_hash, response_json FROM outcomes WHERE submission_key = ?')
      .get(key);
    if (prior) {
      if (prior.payload_hash === hash) {
        res.status(200).json({ ...JSON.parse(prior.response_json), replayed: true });
      } else {
        res.status(409).json({ error: 'idempotency-key-reused-with-different-payload' });
      }
      return;
    }

    const wf = loadValidWorkflow(workflowsDir, body.workflowId, body.workflowVersion, res);
    if (!wf) return;

    const answerErrors = validateAnswers(wf, body.answers);
    if (answerErrors.length) {
      res.status(422).json({ error: 'invalid-answers', details: answerErrors });
      return;
    }

    const dup = db.prepare('SELECT id FROM outcomes WHERE encounter_id = ?').get(body.encounterId);
    if (dup) {
      res.status(409).json({
        error: 'encounter-already-submitted',
        detail: 'a genuine re-screen is a new encounter with a new Idempotency-Key',
      });
      return;
    }

    // Trust boundary: AI results are only believed if this backend produced
    // and stored them for this same encounter and workflow.
    const aiByStep = {};
    for (const evaluationId of body.evaluationIds) {
      const row = db.prepare('SELECT * FROM ai_evaluations WHERE id = ?').get(evaluationId);
      if (!row) {
        res.status(422).json({ error: 'unknown-evaluation', evaluationId });
        return;
      }
      // Evaluations cannot cross encounters, workflows or workflow versions.
      if (row.encounter_id !== body.encounterId || row.workflow_id !== body.workflowId
        || row.workflow_version !== body.workflowVersion) {
        res.status(422).json({ error: 'evaluation-not-for-this-encounter', evaluationId });
        return;
      }
      // Rebuild the inputs so answers cannot be swapped after evaluation.
      const evalStep = stepsById(wf).get(row.step_id);
      if (evalStep?.kind !== 'ai') {
        res.status(422).json({ error: 'evaluation-step-missing', evaluationId });
        return;
      }
      const rebuilt = mapModelInputs(wf, evalStep, (b) => body.answers[b.field]);
      if (!rebuilt.ok || stableStringify(rebuilt.inputs) !== stableStringify(JSON.parse(row.inputs_json))) {
        res.status(422).json({ error: 'evaluation-inputs-mismatch', evaluationId });
        return;
      }
      aiByStep[row.step_id] = {
        label: row.label, score: row.score, confidence: row.confidence, modelVersion: row.model_version,
      };
    }

    let terminal;
    try {
      terminal = computeTerminal(wf, body.answers, aiByStep).terminal;
    } catch (e) {
      if (e instanceof EngineError) {
        res.status(422).json({ error: 'workflow-rules-violation', detail: e.message });
        return;
      }
      throw e;
    }
    if (terminal !== body.finalStepId) {
      res.status(422).json({ error: 'outcome-mismatch', claimed: body.finalStepId, expected: terminal });
      return;
    }

    const outcomeStep = stepsById(wf).get(terminal);
    const response = {
      outcomeId: `out-${randomUUID()}`,
      encounterId: body.encounterId,
      outcomeCode: outcomeStep.code,
      outcomeLabel: pickText(outcomeStep.label),
      status: 'stored',
      submittedAt: new Date().toISOString(),
    };

    try {
      db.exec('BEGIN');
      db.prepare(`INSERT INTO outcomes
        (id, encounter_id, submission_key, payload_hash, workflow_id, workflow_version,
         final_step_id, outcome_code, answers_json, evaluation_ids_json, worker_ref,
         response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(response.outcomeId, body.encounterId, key, hash, wf.id, wf.version,
          terminal, outcomeStep.code, JSON.stringify(body.answers), JSON.stringify(body.evaluationIds),
          body.workerRef ?? null, JSON.stringify(response), new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      // Concurrent retry race: the unique constraint decides; the loser replays.
      const again = db.prepare('SELECT payload_hash, response_json FROM outcomes WHERE submission_key = ?')
        .get(key);
      if (again && again.payload_hash === hash) {
        res.status(200).json({ ...JSON.parse(again.response_json), replayed: true });
        return;
      }
      if (String(e instanceof Error ? e.message : e).includes('UNIQUE')) {
        res.status(409).json({ error: 'encounter-already-submitted' });
        return;
      }
      throw e;
    }

    res.status(201).json({ ...response, replayed: false });
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: 'invalid-image-upload', detail: err.code });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid-json' });
      return;
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request-too-large' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}
