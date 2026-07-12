import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Loaded via the runtime API instead of a static import: bundlers that predate
// the node:sqlite builtin (vitest's vite 5) would otherwise try to resolve it.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

// SQLite via the Node built-in driver: durable in Docker on a named volume,
// zero native dependencies, and ':memory:' doubles as the test database.
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS ai_evaluations (
      id               TEXT PRIMARY KEY,
      encounter_id     TEXT NOT NULL,
      workflow_id      TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      step_id          TEXT NOT NULL,
      model            TEXT NOT NULL,
      model_version    TEXT NOT NULL,
      inputs_json      TEXT NOT NULL,
      label            TEXT NOT NULL,
      score            REAL NOT NULL,
      confidence       REAL NOT NULL,
      image_sha256     TEXT,
      image_bytes      INTEGER,
      created_at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_encounter ON ai_evaluations(encounter_id);

    CREATE TABLE IF NOT EXISTS outcomes (
      id                  TEXT PRIMARY KEY,
      encounter_id        TEXT NOT NULL UNIQUE,
      submission_key      TEXT NOT NULL UNIQUE,
      payload_hash        TEXT NOT NULL,
      workflow_id         TEXT NOT NULL,
      workflow_version    TEXT NOT NULL,
      final_step_id       TEXT NOT NULL,
      outcome_code        TEXT NOT NULL,
      answers_json        TEXT NOT NULL,
      evaluation_ids_json TEXT NOT NULL,
      worker_ref          TEXT,
      response_json       TEXT NOT NULL,
      created_at          TEXT NOT NULL
    );
  `);
  return db;
}
