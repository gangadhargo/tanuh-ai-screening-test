# Risks and Limits

## Threat model

| Priority | Threat | Plausibility | Blast radius | Day 1 control | Remaining risk |
|---|---|---|---|---|---|
| 1 | A tampered client changes answers, claims a safer outcome or submits another encounter's AI result. | High | One encounter per attempt; repeatable from a compromised device | The server validates answer shape and range, checks the stored evaluation's encounter, workflow, version and step, rebuilds its model inputs and recomputes the terminal outcome. | The server proves internal consistency, not that the entered value matches the physical test. There is no authenticated worker or device provenance. A client may also omit AI evidence and force only the conservative error fallback, not a normal result. |
| 2 | A careless or malicious workflow contains script text, unknown controls, broken links or unsafe model bindings. | Medium | Every encounter that receives that workflow version | Plain text only, allow-listed controls, fixed operators, cycle rejection, all-path data checks, fail-closed engine versioning and server-side validation before serving. | Structural checks cannot prove clinical correctness. Day 1 also has no signed workflow, reviewer approval, publish audit or pre-parse byte/depth cap. |
| 3 | A dropped response causes the client to submit the same outcome again. | High | One duplicated encounter record | Client submission UUID, unique SQLite key, canonical payload hash and stored response replay. A changed payload under the same key returns `409`. | Refresh, close, crash or device switch loses the in-memory key and can produce a second record. |
| 4 | A client uploads a file to an AI step that does not declare one, or sends an oversized or unsupported file. | Medium | One request; repeated requests could pressure the API | The XML must bind one image field with `bind="file"`. The server rejects unsolicited files and enforces the field's MIME and size limits. | MIME checks do not prove file content. There is no malware scan. |
| 5 | A user guesses another submission key and replays its stored receipt. | Low | One receipt | Keys are random UUIDs and responses contain no patient name in Day 1. | There is no authentication or ownership check. Production must add both. |
| 6 | A workflow version is bumped during an encounter, or its file is edited without a bump. | Medium | Every affected in-flight or later encounter | Requests name the version label. A bumped label returns `409`; the server does not translate or upgrade the encounter. | Day 1 keeps no retired artifact or content hash. A same-label edit is invisible and can change rules for many encounters. |
| 7 | A client omits an AI evaluation to force the configured error route. | Medium | One encounter per attempt; repeated attempts can overload referral capacity | Every AI step must declare an `onErrorStep`, and omission cannot reach a normal outcome. | The server cannot distinguish genuine AI failure from deliberate omission. Production should record failure attempts and authenticate the worker. |
| 8 | An AI evaluation response is lost and the client retries. | Medium | One duplicate model invocation and an unused evaluation row per retry | The bundled mock is deterministic and cheap; outcome submission trusts only the referenced evaluation ID. | A real model may be expensive or nondeterministic. The evaluation endpoint needs attempt-level idempotency. |
| 9 | The SQLite volume is lost or copied. | Low in the local demo | All stored outcomes | Docker volume provides restart persistence. The demo avoids patient names and does not store image bytes. | No encryption, backup, restore drill or retention policy. |

### Trust boundaries

- The browser is untrusted. Client validation improves usability but does not establish correctness.
- Workflow XML is untrusted until the server parser and validator accept it.
- The Node API is the decision boundary. It owns model selection, evaluation records, outcome recomputation and idempotency.
- SQLite is local to the API container through `node:sqlite`; it is not a network database service.
- The Docker volume persists data but does not provide access control, encryption or backup.

### Sensitive data

Day 1 stores answers, measured values, workflow and model versions, AI results, outcome codes, submission hashes and optional `workerRef`. It does not collect a patient name. An uploaded image exists in request memory long enough to validate and hash it; only the hash and byte count are stored. A real deployment needs HTTPS, authenticated workers, data minimisation, encryption, retention rules and a documented basis for processing health data.

## Operational limits

Day 1 exposes `/health`, returns explicit error codes and writes a minimal structured request log (method, path, status and duration; never answers or clinical values). An invalid workflow is omitted from discovery while `/health` remains green, so field availability can fail silently. Production startup must validate the signed active manifest, readiness must fail when an expected active workflow is invalid, and an alert must name the affected workflow. Logs should also add a request ID, workflow ID and version, encounter ID, model version, evaluation ID, outcome ID and failure code, still without raw answers or image bytes.

## Limits and next

### What we left out

| Cut | Why it was the right cut |
|---|---|
| Authentication, worker roles, patient identity and screening history | The core flow does not need identity to prove workflow execution and outcome persistence. A dummy token would create false confidence without protecting data. |
| Full offline execution, workflow caching, drafts, outbox and background sync | A new AI result still needs the backend. Adding an outbox also forces conflict, freshness and workflow-retirement policy into this weekend implementation. |
| Real model inference and clinical validation | The brief requires a mock. The compact Day 1 descriptors validate inputs, parameters and results. Before replacement, make those descriptors versioned artifacts, add file-consumption semantics and pin them to the approved model digest. Accuracy still needs a separate clinical evaluation. |
| Image retention, content inspection and review | Retention would require object storage, access control, malware handling and a deletion policy. Day 1 proves the bound multipart input and stores only its hash and size. |
| Authoring UI, publishing, approval, rollback and emergency retirement | The brief asks for this system to be described, not built. A safe publishing product is larger than an upload form. |
| Content-addressed workflow registry and model-artifact approval | Git review is enough to demonstrate the contract, but not enough to enforce immutable clinical releases. Production must bind the workflow content hash and approved model digest at publication. |
| Production metrics, traces, backups, migrations and secrets management | The local implementation first proves the trust and idempotency boundaries. A minimal request log exists; the remaining operational signals are named above. |
| Idempotent AI evaluation attempts | The deterministic mock is cheap and the outcome references one stored evaluation. A real model needs replay semantics before replacement. |
| AI steps that consume an earlier AI step's output | Sequential independent AI steps already run on one renderer (engine-tested). Letting a second step read the first's outputs needs a reviewed binding extension in Engine 2, not a rushed Day 1 addition. |

### What breaks first at 10x

Workflow XML is read and parsed on each request, and SQLite serialises writes. Cache validated workflows by ID and version, measure write contention, set a busy timeout and keep transactions short. The current synchronous SQLite API is acceptable only while request volume is small.

### What breaks first at 100x

The local SQLite file prevents safe horizontal API scaling. Move outcomes and idempotency records to Postgres, evidence files to object storage, and run stateless Node replicas. Serve versioned workflow documents from a cache or CDN after adding signed publishing and retirement controls.

### Single riskiest assumption

A usable connection exists when the flow reaches the AI step. If field sites cannot meet that assumption, the core screening cannot finish and the Day 1 architecture is wrong for them.

### What we would build with another week

First add an IndexedDB draft and outbox with a visible sync state. Cache only approved workflow versions and check retirement before evaluation or submission. Then add a content-addressed workflow registry, pinned model artifacts and idempotent evaluation attempts. This protects entered data during drops without pretending the model can run offline, while closing the release-integrity gaps before real clinical use.
