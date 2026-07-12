# Data-Driven Screening Platform

> Runnable Day 1 implementation for two XML-driven screenings. The AI is a deterministic mock, not a diagnostic model.

## Run locally

```bash
docker compose up --build
```

Web app: http://localhost:8080. API health: http://localhost:3000/health.
Outcomes persist in SQLite on a named Docker volume and survive container
restarts. Without Docker (Node 24+): `cd app && npm install`, then
`npm run dev:api` and `npm run dev:web`; checks: `npm test` and
`npm run validate:workflows`.
If any issues occur while running Manual command please check your node version. it should be default to 24

## Repository layout

- `app/`: the web renderer, Node API and shared workflow engine.
- `design/`: architecture, decisions, risks and diagrams.
- `workflows/`: the XML screening definitions.

## Submission checklist

- [x] A runnable local repository with one documented command.
- [x] A documented workflow format and API contract.
- [x] A generic frontend renderer and Node backend.
- [x] Two structurally different sample workflow XML files.
- [x] Decision log.
- [x] Trade-off register.
- [x] Threat model.
- [x] Limits and next steps.

The optional screen recording is not included.

## Design documents

- [Architecture and workflow contract](design/ARCHITECTURE_WORKSHOP.md)
- [Decision log and trade-off register](design/design-decisions.md)
- [Threat model, limits and next](design/risks-and-limits.md)
- [Architecture diagram](design/diagrams/README.md)

## Architecture in one minute

1. A health worker selects a screening. React fetches its server-validated XML and the shared engine renders the steps.
2. Ordinary answers and branches run on the device. The browser calls one backend endpoint when the XML reaches an AI step.
3. The Node API reloads the trusted workflow, maps canonical inputs, runs the declared mock model and stores the evaluation with the resolved model version.
4. The browser submits its claimed terminal outcome with the answers, evaluation IDs and a client-generated retry key.
5. The API treats the browser as untrusted: it rebuilds the model inputs, checks the stored evaluations, recomputes the path and commits the outcome and replay record together in SQLite. This proves internal consistency, not that a worker entered the real-world measurement honestly.

The full-outage boundary is deliberate: entered answers remain in the mounted page, but a new AI result needs connectivity. Refreshing or closing the page loses that in-memory encounter in Day 1. If the AI call fails, the XML routes to a manual fallback. A client can force that conservative route by omitting an evaluation, but cannot use the omission to claim a normal result.

## Sample workflows

- [Pregnancy anaemia screening with value and image input](workflows/anemia-screening.xml)
- [Questionnaire-based risk screening](workflows/questionnaire-risk-screening.xml)

### Public-health references

The sample workflows use the public-health sources below. The mock is not a diagnostic product and does not claim clinically validated decisions.

- **Pregnancy anaemia screening:** [Anemia Mukt Bharat Abhiyaan Operational Guidelines 2026](https://www.nhm.gov.in/New-Update-2025-26/Nutrition/AMB-guidelines/AMB-Abhiyaan-Guidelines.pdf) describes field Hb testing and referral thresholds. The demo collects the measured value and an optional device photo; it does not infer a diagnosis from the image.
- **Questionnaire-based risk screening:** [Community Based Assessment Checklist (CBAC), Ministry of Health and Family Welfare](https://aam.mohfw.gov.in/download/document/b793163e3b2e8537ac8af83effb7bfd0.pdf) provides concrete questions covering age, tobacco, alcohol, waist measurement, physical activity and family history.

## Design method

Each decision records the alternatives, the Day 1 choice, its cost and the work left for later.

## Workflow format

Engine 1 is a small XML language. A workflow contains metadata and a graph of four step types:

| Element | Job |
|---|---|
| `input-step` | Collect `choice`, `number`, `text` or `image` fields. |
| `ai-step` | Select a model and version, bind inputs and outputs, set parameters, and name normal, low-confidence and error routes. |
| `branch-step` | Test canonical answers or bound AI outputs with fixed `when`, `all` and `any` conditions. |
| `outcome-step` | End with a stable code, severity, display label and advice. |

To add a screening:

1. Copy one file in `workflows/`, then change its ID, semantic version, metadata and source reference.
2. Give every step, field and AI output alias a unique ID. Link each non-terminal step explicitly.
3. Map AI inputs with `bind="value"`, `bind="score"` or `bind="file"`. Map `label`, `score` and `confidence` back to workflow aliases.
4. Provide low-confidence and error targets. Use only the documented elements and operators.
5. Run `cd app && npm run validate:workflows`.

Unknown engine versions, elements, bindings, operators, cycles and references to unavailable data fail closed. Workflow text is plain text; it cannot provide HTML, JavaScript or expressions. The full element rules and a binding example are in the [workflow format contract](design/ARCHITECTURE_WORKSHOP.md#workflow-format).

### API contract

All routes are under the Node service on port `3000`.

| Method and path | Request | Success | Main failures |
|---|---|---|---|
| `GET /health` | None | `200 {"status":"ok"}` | Service unavailable |
| `GET /api/v1/workflows` | None | `200` workflow metadata array | Invalid workflows are omitted |
| `GET /api/v1/workflows/:id` | Workflow ID | `200 application/xml` plus `X-Workflow-Version` | `404` unknown; `500` invalid server workflow |
| `POST /api/v1/ai/evaluations` | JSON metadata, or multipart `metadata` plus the XML-bound `image` | `201` with `evaluationId`, `label`, `score`, `confidence`, `modelVersion` and `imageReceived` | `400` invalid input/file; `404` unknown workflow; `409` version mismatch; `500` mock failure |
| `POST /api/v1/outcomes` | JSON outcome plus `Idempotency-Key` header | `201` first write; `200` exact replay | `400` invalid request/key; `409` changed replay, duplicate encounter or version mismatch; `422` answers/evaluation/outcome inconsistent |

Day 1 has only Engine 1, so discovery omits engine capabilities. Before Engine 2 is activated, the list or signed manifest must include `engine` and minimum client capabilities. A stale client can then hide incompatible screenings before selection and still validate the fetched XML before rendering.

Evaluation metadata:

```json
{
  "encounterId": "enc-123",
  "workflowId": "anemia-screening",
  "workflowVersion": "1.1.0",
  "stepId": "anemia-ai",
  "inputs": { "value": 8.2 }
}
```

Outcome body:

```json
{
  "encounterId": "enc-123",
  "workflowId": "anemia-screening",
  "workflowVersion": "1.1.0",
  "finalStepId": "anc-referral",
  "answers": { "haemoglobin": 8.2 },
  "evaluationIds": ["eval-456"],
  "workerRef": "worker-optional"
}
```

The browser creates one random submission UUID before the first save attempt. While that mounted encounter retains the UUID, the same key and payload replays the stored response; the same key with changed data returns `409` and stores nothing. Refreshing or closing the page loses the key, so Day 1 cannot prevent a duplicate if the first response was lost. Persisting the encounter and key in an IndexedDB outbox is deferred.

AI evaluation calls are not idempotent in Day 1. If their response is lost, Retry runs the cheap deterministic mock again and may leave an unused evaluation row. A real or costly model needs an evaluation-attempt key tied to the encounter, AI step and canonical inputs.

### How the renderer stays generic

- `app/engine` parses, validates and executes the same workflow model for browser and server.
- React maps the four field types to an allow-listed component registry. It contains no anaemia or CBAC branches.
- XML owns order, validation data, AI bindings, branch conditions and outcome copy. The browser runs ordinary steps locally after one fetch.
- The server does not trust the browser's terminal step. It reloads the workflow, checks stored AI inputs against submitted answers and recomputes the outcome.

### Design rationale

Day 1 uses React, one Node API, a mock model module and SQLite on a Docker volume. This keeps the trust checks and retry semantics visible without adding a second service or a production authoring system. It tolerates slow or dropped requests but needs connectivity for the AI call. The [decision log](design/design-decisions.md) records the rejected alternatives and costs. The [runtime diagram](design/diagrams/README.md) shows the boundaries.

React components use JSX; frontend helpers, the shared engine and the Node API use plain ESM JavaScript. This keeps the code easy to explain in the interview. Zod, workflow validation and focused tests protect the runtime boundaries; the cost is fewer compile-time checks during refactoring.

### Extensibility, versioning, security, offline use, accessibility and operations

| Area | Day 1 answer | Limit or next step |
|---|---|---|
| Extensibility | New screenings use XML only. A new input or step type needs an Engine 2 code release. | Add compatibility fixtures, capability metadata and migration notes before activating new types. |
| Versioning | Repository policy requires a new version label for content changes. The server and browser refuse non-Engine 1 workflows. New XML syntax creates Engine 2, which is activated only for capable clients; a newer client keeps its Engine 1 parser for older files. Additive API response fields stay in `v1`; breaking request or meaning changes use `/api/v2`. | Day 1 serves one current file per workflow ID and cannot enforce immutability. Before Engine 2, add capability discovery. Add a signed, content-addressed release registry, retain approved versions during a grace period and run API versions in parallel during migration. |
| Security | Server validation, plain text rendering, allow-listed controls, stored evaluation checks and outcome recomputation. Missing AI evidence can reach only the declared manual fallback, not a normal outcome. | The server cannot verify the physical measurement. Add authenticated workers, device provenance where justified, a server-recorded failure receipt, signed publishing, encryption and audit logs. |
| Offline and freshness | Inputs run locally after one XML fetch; retries are safe. The AI step needs a connection and workflow responses are not cached. | Add IndexedDB drafts and outbox, then design signed cache and emergency retirement together. |
| Accessibility and equity | Large controls, explicit wait/error states, disclaimer text and canonical values separate from labels. | English-only Day 1 excludes workers who need local language or RTL text. Add human-reviewed BCP 47 label sets such as `hi`, `te` or `ta`, with explicit English fallback; never translate canonical values. Full outages also exclude some field sites. |
| Operations | Health endpoint, explicit failure codes and JSON request logs with timestamp, method, path, status and duration. Raw answers and image bytes are not logged. | `/health` does not report an invalid active workflow. Add startup validation, readiness against the signed active manifest, request IDs, metrics, traces, backup and restore. |
| Testing | Automated engine and API tests target branching, graph safety, model contracts, outcome trust and idempotency. A focused browser-boundary test rejects an unsupported engine before rendering. The two complete journeys, Slow 3G and reconnect remain short manual checks. | No load, chaos, broad browser, visual regression or real-model accuracy tests. |
| Authoring | Day 1 uses XML in Git, examples, validation and code review. A production flow separates clinical author, reviewer and publisher. Publication resolves the XML model constraint to an approved, immutable model artifact and signs the release. | Deliver an active-version manifest, retain safe versions for in-flight encounters, and support audited rollback or emergency retirement. |
