import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/routes.js';
import { MODELS } from '../src/mock-ai.js';
import { loadWorkflows } from '../src/workflows.js';

const workflowsDir = fileURLToPath(new URL('../../../workflows', import.meta.url));
// Ganga's in-memory database, in the place it belongs: tests.
const db = openDb(':memory:');
const app = createApp(db, workflowsDir);

const anemiaAnswers = { haemoglobin: '9' };

async function runEvaluation(encounterId) {
  const res = await request(app).post('/api/v1/ai/evaluations').send({
    encounterId,
    workflowId: 'anemia-screening',
    workflowVersion: '1.1.0',
    stepId: 'anemia-ai',
    inputs: { value: 9 },
  });
  expect(res.status).toBe(201);
  return res.body;
}

function outcomeBody(encounterId, evaluationId, overrides = {}) {
  return {
    encounterId,
    workflowId: 'anemia-screening',
    workflowVersion: '1.1.0',
    finalStepId: 'anc-referral',
    answers: anemiaAnswers,
    evaluationIds: [evaluationId],
    ...overrides,
  };
}

function temporaryWorkflow(file, change) {
  const dir = mkdtempSync(join(tmpdir(), 'screening-workflow-'));
  const xml = readFileSync(join(workflowsDir, file), 'utf8');
  writeFileSync(join(dir, file), change(xml));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('mock models', () => {
  it('threshold bands are driven entirely by XML params', () => {
    const model = MODELS.get('threshold-bands');
    expect(model.run({ value: 6 }, { severeBelow: '7', moderateBelow: '11' }).label).toBe('severe');
    expect(model.run({ value: 9 }, { severeBelow: '7', moderateBelow: '11' }).label).toBe('moderate');
    expect(model.run({ value: 13 }, { severeBelow: '7', moderateBelow: '11' }).label).toBe('normal');
  });
});

describe('workflow serving', () => {
  it('lists both sample workflows', async () => {
    const res = await request(app).get('/api/v1/workflows');
    expect(res.status).toBe(200);
    expect(res.body.map((w) => w.id).sort()).toEqual([
      'anemia-screening', 'questionnaire-risk-screening',
    ]);
  });

  it('serves validated XML with version header', async () => {
    const res = await request(app).get('/api/v1/workflows/anemia-screening');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('xml');
    expect(res.headers['x-workflow-version']).toBe('1.1.0');
  });

  it.each([
    {
      name: 'inverted threshold bands',
      file: 'anemia-screening.xml',
      change: (xml) => xml.replace('name="severeBelow" value="7"', 'name="severeBelow" value="12"'),
      error: 'requires severeBelow < moderateBelow',
    },
    {
      name: 'incorrect threshold-bands input alias',
      file: 'anemia-screening.xml',
      change: (xml) => xml.replace('as="value" bind="value"', 'as="reading" bind="value"'),
      error: 'requires exactly one numeric input bound as "value"',
    },
    {
      name: 'non-positive weighted-score referral threshold',
      file: 'questionnaire-risk-screening.xml',
      change: (xml) => xml.replace('name="referAt" value="5"', 'name="referAt" value="0"'),
      error: 'requires referAt > 0',
    },
    {
      name: 'file input on a model that accepts scores only',
      file: 'questionnaire-risk-screening.xml',
      change: (xml) => xml
        .replace('<field id="age" type="choice"', '<field id="photo" type="image" required="false"/>\n      <field id="age" type="choice"')
        .replace('<input field="age"', '<input field="photo" as="image" bind="file"/>\n      <input field="age"'),
      error: 'does not accept file inputs',
    },
  ])('rejects $name while loading', ({ file, change, error }) => {
    const fixture = temporaryWorkflow(file, change);
    try {
      const [loaded] = loadWorkflows(fixture.dir);
      expect(loaded.errors.join(' ')).toContain(error);
    } finally {
      fixture.remove();
    }
  });

  it('does not serve a workflow whose model contract is invalid', async () => {
    const fixture = temporaryWorkflow(
      'anemia-screening.xml',
      (xml) => xml.replace('name="moderateBelow" value="11"', 'name="moderateBelow" value="not-a-number"'),
    );
    try {
      const invalidApp = createApp(openDb(':memory:'), fixture.dir);
      const list = await request(invalidApp).get('/api/v1/workflows');
      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);

      const get = await request(invalidApp).get('/api/v1/workflows/anemia-screening');
      expect(get.status).toBe(500);
      expect(get.body.error).toBe('workflow-failed-validation');
      expect(get.body.details.join(' ')).toContain('param "moderateBelow" must be numeric');
    } finally {
      fixture.remove();
    }
  });

  it('rejects duplicate workflow ids across files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'screening-workflow-'));
    const xml = readFileSync(join(workflowsDir, 'anemia-screening.xml'), 'utf8');
    writeFileSync(join(dir, 'first.xml'), xml);
    writeFileSync(join(dir, 'second.xml'), xml);
    try {
      const loaded = loadWorkflows(dir);
      expect(loaded).toHaveLength(2);
      expect(loaded.every((entry) => entry.errors.join(' ').includes('duplicate workflow id'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('model result contract', () => {
  it('returns ai-error and stores nothing when an adapter returns an invalid result', async () => {
    const original = MODELS.get('threshold-bands');
    MODELS.set('threshold-bands', {
      ...original,
      run() {
        return {
          label: 'invented-label',
          score: Number.POSITIVE_INFINITY,
          confidence: -0.1,
          modelVersion: 'threshold-bands@9.9.9',
          internalDebug: 'must-not-leak',
        };
      },
    });

    try {
      const encounterId = 'enc-invalid-model-result';
      const res = await request(app).post('/api/v1/ai/evaluations').send({
        encounterId,
        workflowId: 'anemia-screening',
        workflowVersion: '1.1.0',
        stepId: 'anemia-ai',
        inputs: { value: 9 },
      });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('ai-error');
      expect(res.body.detail).toContain('invalid model result');
      expect(res.body.detail).toContain('modelVersion');
      expect(res.body.detail).toContain('unexpected result field');

      const stored = db.prepare('SELECT COUNT(*) AS count FROM ai_evaluations WHERE encounter_id = ?')
        .get(encounterId);
      expect(stored.count).toBe(0);
    } finally {
      MODELS.set('threshold-bands', original);
    }
  });
});

describe('outcome submission: idempotency and trust boundary', () => {
  it('stores once, replays on retry, rejects a mutated retry', async () => {
    const encounterId = 'enc-idem-1';
    const { evaluationId, label } = await runEvaluation(encounterId);
    expect(label).toBe('moderate');
    const key = 'key-idem-1-0000';

    const first = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', key).send(outcomeBody(encounterId, evaluationId));
    expect(first.status).toBe(201);
    expect(first.body.outcomeCode).toBe('refer-anc');

    const replay = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', key).send(outcomeBody(encounterId, evaluationId));
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.outcomeId).toBe(first.body.outcomeId);

    const mutated = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', key)
      .send(outcomeBody(encounterId, evaluationId, { answers: { ...anemiaAnswers, haemoglobin: '8' } }));
    expect(mutated.status).toBe(409);
    expect(mutated.body.error).toBe('idempotency-key-reused-with-different-payload');
  });

  it('rejects a second outcome for the same encounter under a new key', async () => {
    const encounterId = 'enc-dup-1';
    const { evaluationId } = await runEvaluation(encounterId);
    await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-dup-1-0000').send(outcomeBody(encounterId, evaluationId));
    const second = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-dup-2-0000').send(outcomeBody(encounterId, evaluationId));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('encounter-already-submitted');
  });

  it('refuses an evaluation recorded under a different workflow version', async () => {
    db.prepare(`INSERT INTO ai_evaluations
      (id, encounter_id, workflow_id, workflow_version, step_id, model, model_version,
       inputs_json, label, score, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('eval-oldver', 'enc-oldver', 'anemia-screening', '0.9.0', 'anemia-ai',
        'threshold-bands', 'threshold-bands@1.0.0', '{}', 'moderate', 0.6, 0.9,
        new Date().toISOString());
    const res = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-oldver-0000')
      .send(outcomeBody('enc-oldver', 'eval-oldver'));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('evaluation-not-for-this-encounter');
  });

  it('refuses an outcome whose answers do not match the evaluated inputs', async () => {
    const encounterId = 'enc-swap';
    const { evaluationId } = await runEvaluation(encounterId); // evaluated with Hb 9
    const res = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-swap-00000')
      .send(outcomeBody(encounterId, evaluationId, { answers: { haemoglobin: '13' } }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('evaluation-inputs-mismatch');
  });

  it('refuses an evaluation that belongs to another encounter', async () => {
    const { evaluationId } = await runEvaluation('enc-owner');
    const res = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-steal-0000').send(outcomeBody('enc-thief', evaluationId));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('evaluation-not-for-this-encounter');
  });

  it('refuses a claimed outcome the workflow does not produce', async () => {
    const encounterId = 'enc-claim-1';
    const { evaluationId } = await runEvaluation(encounterId);
    const res = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-claim-0000')
      .send(outcomeBody(encounterId, evaluationId, { finalStepId: 'above-threshold' }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('outcome-mismatch');
    expect(res.body.expected).toBe('anc-referral');
  });

  it('requires the Idempotency-Key header', async () => {
    const res = await request(app).post('/api/v1/outcomes').send(outcomeBody('enc-x', 'eval-x'));
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range answers server-side', async () => {
    const encounterId = 'enc-range-1';
    const { evaluationId } = await runEvaluation(encounterId);
    const res = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-range-0000')
      .send(outcomeBody(encounterId, evaluationId, { answers: { haemoglobin: '99' } }));
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('invalid-answers');
  });
});

describe('file binding contract', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');

  it('accepts a file only where the XML binds one', async () => {
    const res = await request(app).post('/api/v1/ai/evaluations')
      .field('metadata', JSON.stringify({
        encounterId: 'enc-file-ok', workflowId: 'anemia-screening', workflowVersion: '1.1.0',
        stepId: 'anemia-ai', inputs: { value: 9 },
      }))
      .attach('image', png, { filename: 'reading.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.imageReceived).toBe(true);
  });

  it('rejects an unsolicited file on a step with no file binding', async () => {
    const res = await request(app).post('/api/v1/ai/evaluations')
      .field('metadata', JSON.stringify({
        encounterId: 'enc-file-bad', workflowId: 'questionnaire-risk-screening', workflowVersion: '1.1.0',
        stepId: 'ncd-risk-ai',
        inputs: {
          age: '50-plus', tobacco: 'daily', alcohol: 'yes',
          waist: 'band-0', activity: 'active', familyHistory: 'yes',
        },
      }))
      .attach('image', png, { filename: 'sneaky.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsolicited-file');
  });

  it('rejects an unsupported file type on a bound image field', async () => {
    const res = await request(app).post('/api/v1/ai/evaluations')
      .field('metadata', JSON.stringify({
        encounterId: 'enc-file-type', workflowId: 'anemia-screening', workflowVersion: '1.1.0',
        stepId: 'anemia-ai', inputs: { value: 9 },
      }))
      .attach('image', Buffer.from('plain text'), { filename: 'reading.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported-image-type');
  });
});

describe('request boundary', () => {
  it('rejects malformed JSON as a client error', async () => {
    const res = await request(app).post('/api/v1/outcomes')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid-json');
  });

  it('rejects blank and non-finite numeric input', async () => {
    for (const value of ['', 'Infinity']) {
      const res = await request(app).post('/api/v1/ai/evaluations').send({
        encounterId: `enc-number-${value || 'blank'}`,
        workflowId: 'anemia-screening',
        workflowVersion: '1.1.0',
        stepId: 'anemia-ai',
        inputs: { value },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid-input');
    }
  });
});

describe('questionnaire workflow (scores mapped server-side from XML)', () => {
  it('runs the second workflow through the same endpoints unmodified', async () => {
    const encounterId = 'enc-cbac-1';
    const answers = {
      age: '50-plus', tobacco: 'daily', alcohol: 'yes',
      waist: 'band-0', activity: 'active', familyHistory: 'yes',
    };
    const evalRes = await request(app).post('/api/v1/ai/evaluations').send({
      encounterId,
      workflowId: 'questionnaire-risk-screening',
      workflowVersion: '1.1.0',
      stepId: 'ncd-risk-ai',
      inputs: answers,
    });
    expect(evalRes.status).toBe(201);
    expect(evalRes.body.label).toBe('high-risk'); // 2+2+1+0+0+2 = 7 >= 5 (CBAC: above 4)

    const res = await request(app).post('/api/v1/outcomes')
      .set('Idempotency-Key', 'key-cbac-0000')
      .send({
        encounterId,
        workflowId: 'questionnaire-risk-screening',
        workflowVersion: '1.1.0',
        finalStepId: 'refer-ncd',
        answers,
        evaluationIds: [evalRes.body.evaluationId],
      });
    expect(res.status).toBe(201);
    expect(res.body.outcomeCode).toBe('refer-ncd-screening');
  });
});
