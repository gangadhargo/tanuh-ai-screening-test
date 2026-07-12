# Architecture and Workflow Contract

This document defines the Day 1 architecture and the boundaries kept for later work.

## Scope

| Area | Day 1 | Add later |
|---|---|---|
| Client delivery | Small web application | Native Android application |
| Connectivity | Slow or intermittent internet with retry-safe requests. Connectivity is required at the mock-AI step. | Fully offline execution, IndexedDB outbox and background synchronisation. |
| AI execution | Mock risk-screening module behind the Node API. It is not a medical diagnosis. | Real model integration and a separate AI service only if deployment or scaling requires it. |
| Runtime inputs | Questionnaire answers, measured values and an optional evidence image declared by the workflow XML. | Image-quality checks, device-camera guidance and real image-model inference. |

## Real-world flow

- A health worker runs a screening with a person using the web application.
- The physical procedure that produces an image or measured value is outside this application's scope. The application collects that input.
- The mocked AI returns a risk-screening result such as a score, label and confidence. It does not perform or claim a medical diagnosis.
- Day 1 assumes some internet availability, even if it is slow or drops temporarily. With no connection at the AI step, the application cannot produce a new dynamic AI result.

## Runtime path and authority

| Stage | Browser responsibility | Server responsibility |
|---|---|---|
| Select | Fetch the server-validated XML and run the shared Engine 1 validator again before rendering. | Parse and validate the active XML before serving it. |
| Collect | Render allow-listed controls, validate for usability and keep encounter state in memory. | No request is needed for each ordinary question. |
| Evaluate | Send only the inputs and optional file bound by the current AI step. | Reload the trusted XML, map canonical inputs, choose the declared model and store the result with its resolved version. |
| Branch | Use answers and bound AI outputs for a responsive next step. | Treat the client's path and claimed terminal step as untrusted. |
| Submit | Send answers, evaluation IDs, claimed terminal step and the retained retry key. | Rebuild evaluation inputs, recompute the path and commit the outcome plus replay record in one SQLite transaction. |

The shared engine is intentional duplication: the browser uses it for the flow, while the server uses the same contract to establish internal consistency. The server can prove that answers, evaluations and the terminal step agree; it cannot prove that the entered measurement matches the physical test. The cost is that an engine change must remain compatible in both runtimes.

## Runtime boundaries

### Browser

- React contains no anaemia or questionnaire branches. Screening-specific fields, order, thresholds and branches come from XML.
- Render XML through an allow-listed component registry.
- Never use `dangerouslySetInnerHTML`, `eval`, `Function` or executable expressions from workflow data.
- Keep loading, empty, validation-error, slow-network and retry states accessible and explicit.
- Download the workflow definition once; reveal the relevant step incrementally without a network request for each ordinary question.

### Node API

- Express owns workflow validation, model selection, stored evaluations, final-outcome recomputation and idempotency.
- The replaceable mock stays behind one API endpoint. A separate service adds no useful boundary until a real model needs a different runtime or scaling policy.
- SQLite stores evaluations and outcomes on the Docker volume. Tests use SQLite in memory.
- Authentication, a native/PWA layer and offline synchronisation are outside Day 1.

## Focused test strategy

The automated tests target the contracts most likely to create a wrong or duplicate outcome:

1. **Workflow engine:** both submitted XML files parse and pass validation; unsupported input types, broken links, cycles, data used before it exists and executable markup are rejected. Prove one answer-driven branch, one AI-result branch, and the configured low-confidence/error fallback. Test only the operators and input types used by the two samples.
2. **Node API:** exercise the real routes. Prove each compact model contract, value input and multipart image constraints, rejection of an unknown workflow/version/step, strict model-result validation and server recomputation of the final outcome. Prove idempotency precisely: first submission stores one outcome; same key plus same canonical payload replays the same outcome; same key plus changed payload returns `409`; a new screening with a new key succeeds.
3. **Browser boundary:** one focused test proves that an unsupported engine is rejected before React renders it. Full browser automation stays out of scope because the server rechecks the safety-critical decision.

The two complete rendered journeys remain short manual checks. The server rechecks their safety-critical decisions:

- Start from a fresh checkout with the documented Docker Compose command and complete both workflows.
- In browser Slow 3G mode, confirm ordinary questions do not make a request per step and the AI wait state is clear.
- Drop the connection during final submission, reconnect and Retry without refreshing; confirm only one outcome is stored.
- Edit an XML prompt or branch and confirm the flow changes without a React code change.

Day 1 excludes real-model accuracy, offline outbox tests, authoring and RBAC tests, load and chaos tests, visual regression, broad browser matrices, XML fuzzing and coverage targets. They do not justify their cost for this implementation.

## Architecture diagram

- [Checked PNG export](diagrams/screening-runtime-architecture.png)

## Workflow definition versus encounter data

| Item | Real-world meaning | Created by | When it exists | Day 1 handling |
|---|---|---|---|---|
| Workflow XML | The reusable recipe: ordered steps, input definitions, AI configuration, branches and outcomes. | A clinical author in the real system; repository author for this demo. | Before any screening encounter. | Two XML files stored with the backend and validated before serving. |
| Answers, measured values or images | Data collected for one person during one screening. | The health worker and person being screened. | During a screening encounter. | The generic renderer collects only the input types declared by the selected XML. |
| Renderer components | The allow-listed implementation of controls such as question, number and image input. | Frontend engineers. | Shipped as application code. | The XML selects existing component types; it cannot inject arbitrary code or HTML. |

An image is encounter data, not an alternative to XML. The XML declares the image field and the AI step that accepts it. The renderer collects the file for that encounter. Workflow upload, publishing and RBAC remain later work.

## Reference workflows

| Candidate | Official reference | Concrete frontend inputs | Boundary |
|---|---|---|---|
| Pregnancy anaemia screening | [Anemia Mukt Bharat Abhiyaan Operational Guidelines 2026](https://www.nhm.gov.in/New-Update-2025-26/Nutrition/AMB-guidelines/AMB-Abhiyaan-Guidelines.pdf) | A haemoglobin value obtained from an external field test and an optional image of the device display. | The workflow is limited to one cohort because Hb thresholds vary by population. The image is evidence, not diagnostic input. |
| Questionnaire-based NCD risk screening | [Community Based Assessment Checklist (CBAC), Ministry of Health and Family Welfare](https://aam.mohfw.gov.in/download/document/b793163e3b2e8537ac8af83effb7bfd0.pdf) | Age, tobacco use, alcohol use, waist measurement, physical activity and family history. | Canonical answers and scoring references remain separate from translated display labels. |

Image input is part of Day 1. In the anaemia workflow it is optional evidence, not an image diagnosis. The client sends it as multipart data only when the AI step binds that image field. The mock records its hash and size. The configured haemoglobin value drives the result.

## Data model

| Entity | Meaning | Current relationship |
|---|---|---|
| `WorkflowDefinition` | The active XML recipe plus its declared version label. | One definition can drive many encounters. Day 1 serves one file per workflow ID. |
| `Encounter` | One run of one workflow for one person. | References one workflow version and may have AI evaluations. |
| `AiEvaluation` | The structured result from one mocked AI step. | Belongs to one encounter and records model version, score, label and confidence. |
| `Outcome` | The final submitted result of the encounter. | At most one accepted Day 1 outcome per encounter. |
| `IdempotencyRecord` | The client submission key, canonical payload hash and stored response. | Prevents duplicate writes when the client retains and reuses the key. |

These are logical entities, not five Day 1 tables. `WorkflowDefinition` is the active XML file; `Encounter` is the client-generated ID stored on evaluation and outcome rows; the idempotency fields live with the outcome. SQLite has separate `ai_evaluations` and `outcomes` tables. Day 1 records the XML version label but does not keep a version-addressed artifact or content hash. A version bump is enforced by repository review, not by storage.

`User` and `HealthWorker` management are outside Day 1. Encounters may carry `workerRef` for future history and RBAC, but Day 1 does not authenticate it.

## API contract

Day 1 exposes only the endpoints needed to list and serve workflows, run the mock AI, persist outcomes and report service health. The mock remains a module behind the Node API. A separate AI service is out of scope.

| Method | Path | Purpose | Day 1 behaviour |
|---|---|---|---|
| `GET` | `/api/v1/workflows` | List the screening types available for selection. Return metadata only, not full XML. | Returns valid active workflows and their available languages. Uses `Cache-Control: no-store`. |
| `GET` | `/api/v1/workflows/{workflowId}` | Return the active, server-validated workflow as XML. | Uses `Cache-Control: no-store` and returns `X-Workflow-Version`. |
| `POST` | `/api/v1/ai/evaluations` | Run the mock AI step using inputs mapped by the selected workflow. | Evaluations are stored immediately so the outcome route can trust a server record instead of a client echo. |
| `POST` | `/api/v1/outcomes` | Validate and persist the completed screening outcome. Retries use an `Idempotency-Key` header. | Day 1 guarantee is defined below; authentication and cross-device duplicate detection remain deferred. |
| `GET` | `/health` | Confirm that the Node service is running. | Returns `200 {"status":"ok"}`. |

### Add-later API candidates

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/outcomes/{outcomeId}` | Retrieve one particular submitted screening. Not needed for the Day 1 submission flow. |
| `GET` | `/api/v1/outcomes?workerRef={workerRef}` | Retrieve screening history for a worker. User management, authorization and history are outside Day 1. |

### Workflow-list response

```json
[
  {
    "id": "anemia-screening",
    "version": "1.1.0",
    "title": {
      "en": "Anaemia screening (pregnant women)"
    },
    "availableLanguages": ["en"]
  }
]
```

### Mock-AI request

The frontend identifies the workflow and AI step. The backend loads the trusted workflow configuration and decides which configured mock model may run.

```json
{
  "encounterId": "enc-123",
  "workflowId": "anemia-screening",
  "workflowVersion": "1.1.0",
  "stepId": "anemia-ai",
  "inputs": {
    "value": 8.2
  }
}
```

### Mock-AI response

```json
{
  "evaluationId": "eval-456",
  "label": "moderate",
  "score": 0.6,
  "confidence": 0.72,
  "modelVersion": "threshold-bands@1.0.0",
  "imageReceived": false
}
```

The backend stores each evaluation immediately, including the AI step ID and canonical model inputs. Outcome submission accepts it only when the stored record matches the encounter, workflow ID, workflow version and AI step. The server derives the expected model inputs again from the submitted answers and rejects a mismatch. This prevents a client from evaluating one Hb value and submitting another.

The evaluation endpoint is not idempotent in Day 1. A lost response followed by Retry runs the deterministic mock again and stores another evaluation; only the evaluation ID used by the outcome matters. That is acceptable for the local mock. A costly or nondeterministic model needs a client-generated evaluation-attempt key scoped to the encounter, AI step and canonical inputs. An exact retry then replays the stored result, while changed inputs create a new attempt.

### Idempotent outcome submission

1. Before the first save attempt, the frontend creates a random submission identifier with `crypto.randomUUID()` and keeps it in the mounted encounter state.
2. It sends the identifier in the `Idempotency-Key` request header on the first attempt and every retry.
3. The backend stores the key, a hash of the canonical request payload and the original response in the same transaction as the outcome.
4. The same key and same payload hash returns the original response without creating another outcome.
5. The same key with a different payload hash returns `409 Conflict` rather than guessing which payload is correct.
6. A genuine re-screen is a new encounter and receives a new submission identifier.

Day 1 guarantees idempotency only while the mounted encounter retains and reuses the submission key. A refresh, closed page, crash or device switch loses that client state and may create a duplicate if the first response was lost. The server retains every accepted key and replay record for as long as its outcome. We rejected `encounterId` as the key because it would couple transport retries to domain identity and make a later amend-and-resubmit flow harder to change. An IndexedDB draft and outbox is the next step when reload recovery is in scope.

## Compatibility rules

| Meeting | Rule |
|---|---|
| Old client, new workflow content | Works when the file still uses Engine 1 and the repository author increments the version label. Labels, thresholds, steps and graph links may change. |
| Old client, new XML syntax | The current server and browser refuse it. Any new element, attribute, field type, binding or operator requires Engine 2 and capability-aware activation before it can be served. |
| New client, old workflow | The client keeps the Engine 1 parser and compatibility fixtures until that engine is formally retired. |
| In-flight encounter, version bumped | Evaluation and outcome calls carry the exact workflow version. Day 1 returns `409` rather than upgrading silently. It cannot retrieve the retired file. |
| Active XML edited without a version bump | Day 1 cannot detect this and may run changed rules under the old label. Code review is the only control. Production stores signed, content-addressed releases and loads the exact release by ID and version. |
| Client discovery before Engine 2 | Day 1 omits engine metadata from the list because every active workflow uses Engine 1. Before a second engine is activated, the list or signed manifest carries `engine` and minimum client capabilities; each client cohort sees a compatible active version and still validates the fetched XML. |
| API evolution | Optional response fields may be added to `/api/v1`. A breaking request, response meaning or route change uses `/api/v2`; both versions run during migration. |

## Authoring and provisioning lifecycle

Day 1 keeps the two XML files in Git and uses the validation command plus code review. The production design is a controlled publication flow, not a general upload endpoint:

1. A clinical author creates a draft from a supported template and chooses a model compatibility constraint from an allow-list.
2. Automated checks validate the XML graph, sample encounters and engine compatibility. A versioned model descriptor defines input types, file consumption, parameter schema and allowed output labels; publication validates the workflow against it and resolves the constraint to an immutable model artifact and digest.
3. A separate clinical reviewer approves the wording, cohort, thresholds, fallbacks and resolved model artifact. Model changes require regression, calibration and clinical reapproval. RBAC prevents self-publishing.
4. Publishing stores the workflow by content hash, signs the workflow and resolved model digest, and updates an active-version manifest for clients.
5. Normal rollback reactivates the last approved version for new encounters. Safe older versions remain available for a short in-flight grace period.
6. Emergency retirement blocks new evaluation and submission against the unsafe version, records who retired it and why, and sends the worker to restart or use the manual fallback.

Day 1's bundled mock has one installed implementation per model major. A compact code descriptor defines each model's inputs, parameters, labels and numeric result bounds. Workflow loading validates against it before serving XML, and runtime validation rejects an invalid adapter result before storage. The descriptor is not yet a signed, independently versioned artifact. Production publication must pin both the descriptor and model digest. An invalid result enters the AI error state and cannot fall through to a normal branch; the worker may continue only through the XML `onErrorStep`.

## Workflow format

Engine 1 is the Day 1 XML contract. It uses named steps and explicit links instead of executable expressions. Unknown engine versions, step types, field types, binding modes and operators fail closed.

### Document shape

| Element | Purpose |
|---|---|
| `<workflow id version engine>` | Declares the workflow ID, release label and renderer contract it needs. |
| `<metadata>` | Holds localized title, description and disclaimer text plus source references. |
| `<steps start>` | Names the first step and contains the step graph. |
| `<input-step>` | Collects allow-listed `choice`, `number`, `text` or `image` fields, then names its next step. |
| `<ai-step>` | Selects the model and version constraint, binds collected inputs and model outputs, carries parameters, and names low-confidence, error and normal routes. |
| `<branch-step>` | Routes through structured `when`, `all` and `any` conditions over canonical answers or bound AI outputs. |
| `<outcome-step>` | Ends the screening with a stable code, severity, localized label and advice. |

### Authoring reference

A clinical author can copy either submitted XML file and change only the configuration below. IDs use letters, numbers, `_` or `-`. Every link names another step ID in the same file.

| Location | Required form | Rules |
|---|---|---|
| Root | `<workflow id="..." version="MAJOR.MINOR.PATCH" engine="1">` | Repository policy requires a new version for changed meaning. Day 1 does not enforce content immutability. Engine `1` files start on an `input-step`. |
| Metadata | `<title lang="...">`, with optional `description`, `disclaimer` and `<reference href="..." label="..."/>` | Repeat localized text with the same element and a different `lang`. IDs and values are never translated. |
| Input | `<input-step id>` with `prompt`, optional `help`, one or more `field` elements and `<next step>` | A field has `id`, `type` and optional `required="false"`. `required` is true by default. |
| Fields | `choice`, `number`, `text` or `image` | A choice has `<option value score><label .../></option>`. A number may set finite `min`, `max` and `unit`. Text is limited to 400 characters. An image may set JPEG/PNG `accept` values and a positive `maxSizeMb` no greater than the 5 MB server ceiling. |
| AI | `<ai-step id model modelVersion lowConfidenceBelow lowConfidenceStep onErrorStep>` with `input`, `output`, optional `param` and `<next step>` | Use `modelVersion="^MAJOR"`. Bind at least one input, map all three outputs exactly once, and name safe low-confidence and error targets. Parameters are model-specific name/value pairs, not expressions. |
| Branch | `<branch-step id>` with ordered `<case step>`, conditions and one `<default step>` | A condition is `<when source="answers|ai" field="..." op="..." value="..."/>`. Use non-empty `all` or `any` groups to combine conditions. Operators are `eq`, `ne`, `lt`, `lte`, `gt`, `gte` and `in`; `in` uses comma-separated canonical values. |
| Outcome | `<outcome-step id code>` with optional `severity`, required `label` and optional `advice` | `severity` defaults to `info`; when present it is `high`, `medium`, `low` or `info`. The `code` is stable data; labels and advice are display text. |

The AI step is fully declared in XML. This is the agreed binding shape:

```xml
<ai-step id="anemia-ai" model="threshold-bands" modelVersion="^1"
         lowConfidenceBelow="0.55" lowConfidenceStep="retest-advice"
         onErrorStep="manual-referral">
  <input field="haemoglobin" as="value" bind="value"/>
  <input field="devicePhoto" as="image" bind="file"/>

  <output from="label" as="riskLabel"/>
  <output from="score" as="riskScore"/>
  <output from="confidence" as="riskConfidence"/>

  <param name="severeBelow" value="7.0"/>
  <param name="moderateBelow" value="11.0"/>
  <next step="triage"/>
</ai-step>

<branch-step id="triage">
  <case step="urgent-referral">
    <when source="ai" field="riskLabel" op="eq" value="severe"/>
  </case>
  <default step="healthy-advice"/>
</branch-step>
```

### Day 1 mock catalog

| Model constraint | Inputs | Parameters | Labels | File policy |
|---|---|---|---|---|
| `threshold-bands`, `^1` | One numeric alias named `value` through `bind="value"` | Numeric `severeBelow` and `moderateBelow`, with `severeBelow < moderateBelow` | `severe`, `moderate`, `normal` | One optional evidence attachment; this mock does not consume its pixels |
| `weighted-score`, `^1` | One or more numeric aliases through `bind="score"` | Numeric `referAt > 0` | `high-risk`, `low-risk` | No file input |

Both mocks return finite `score` and `confidence` values in `[0,1]`. Workflow loading checks the listed inputs and parameters before serving the XML. The API checks labels, numeric bounds, exact resolved model version and unexpected result fields before storing an evaluation.

Input binding modes have narrow meanings:

- `bind="value"` sends the canonical numeric answer.
- `bind="score"` sends the numeric score attached to a canonical choice option.
- `bind="file"` sends the referenced `image` field to the evaluation endpoint as a file attachment. Engine 1 permits at most one file binding per AI step.

The server rejects a file when the current AI step has no `bind="file"` input. For a bound file, it enforces the referenced field's `accept` and `maxSizeMb` rules. The attachment is supporting evidence in the Day 1 anaemia flow, so the threshold mock records only its hash and size and does not consume its pixels. A production model descriptor must say whether a file is evidence-only or a model input; the adapter then receives a structured `{ values, files, params }` envelope. This keeps the frontend and XML binding stable when an image model replaces the mock.

Each `<output>` maps one field from the fixed AI response (`label`, `score` or `confidence`) to the name used by later branch conditions. This keeps model response fields separate from workflow vocabulary.

### Validation rules

- The start step must be an input step in Engine 1.
- Workflow and step IDs must be valid and step IDs must be unique.
- Field IDs and AI output aliases must be unique across one workflow.
- Every step target, input binding and branch reference must resolve.
- Reachable cycles are rejected. An AI binding or branch condition may use data only when it exists on every incoming path.
- Every AI step must bind at least one input, bind each of `label`, `score` and `confidence` once, and declare both low-confidence and error routes.
- A non-file model input must reference a required field. Engine 1 has no optional model-input semantics.
- Engine 1 accepts only a `^MAJOR` model version constraint and checks it against the installed model.
- The bundled model catalog validates model-specific inputs, parameters and output labels before serving or storing data.
- Outcome severity is optional and defaults to `info`; any supplied value outside `high`, `medium`, `low` or `info` is rejected.
- `bind="score"` may reference only a choice field whose options all have scores. `bind="file"` may reference only an image field, and an AI step may have at most one file binding.
- Image `maxSizeMb` must be finite, positive and no greater than 5. Accepted MIME values are limited to the server's supported image types.
- Condition source must be `answers` or `ai`. Unknown XML elements, attributes, sources and operators are rejected, not ignored.
- Localized labels are display text. Canonical option values, field IDs, outcome codes and model inputs are not translated.
- Workflow text is plain text. XML cannot provide HTML, JavaScript or expressions.
- The server validates the workflow before serving it. The browser validates the fetched XML again and uses only its allow-listed React components.

The two files in `workflows/` are the working examples. A new screening may use only Engine 1 features unless the engine contract and both runtimes are versioned first.

The [decision log and trade-off register](design-decisions.md) record the alternatives, costs and rejected options behind this contract.

## Failure modes and safety

### Scenarios named in the brief

| Scenario | Day 1 answer | Status |
|---|---|---|
| Chained AI steps | Engine 1 can run more than one AI step and keeps output aliases, but one AI step cannot feed an earlier AI output into its model input. Use one combined mock or wait for a versioned Engine 2 binding. | Deferred, because the two samples do not need AI-to-AI input. |
| Version changes during an encounter | Evaluation and outcome requests carry the declared workflow version. If the active file has a new version, the API returns `409` and the worker restarts. It never upgrades silently. | Version bumps are handled by blocking. Same-label edits and graceful completion of a retired version remain limits. |
| Low confidence or contradiction | Each AI step must name low-confidence and error targets. A branch may combine prior answers and bound AI outputs. A contradiction should route to manual review, not a normal outcome. | Low confidence and error are handled. Clinical contradiction policy is described, not validated by a real model. |
| Population calibration and equity | Parameters belong to a reviewed workflow version. Day 1 uses a narrow cohort rather than one threshold across populations. | Mitigated by scope. Cohort calibration and fairness testing are deferred. |
| Duplicate submission or real re-screen | A retry keeps the submission UUID. A real re-screen creates a new encounter and UUID. | Handled while the mounted encounter retains its key. Refresh, close and cross-device duplicates remain limits. |
| Localized labels and canonical values | Display strings use language maps. IDs, option values, scores and model inputs do not change with language. | Format handled; Day 1 content is English only. |

For an Indian deployment, keep human-reviewed labels in the XML under BCP 47 tags such as `hi`, `te` or `ta`. Select the worker's exact locale, then its base language, then English. This avoids a translation-service call in the field and keeps canonical values stable. RTL languages still need a renderer-level direction and layout test.

### Additional failure modes

| Failure | Response | Status and reason |
|---|---|---|
| The API commits an outcome but its response is lost. | Retry from the still-mounted encounter returns the stored response. | Handled while the browser retains the key; refresh recovery is deferred. |
| The mock commits an AI evaluation but its response is lost. | Retry runs the deterministic mock again and may store an unused evaluation. | Accepted for a cheap mock. A real model needs an evaluation-attempt key and result replay. |
| A client omits a successful AI evaluation from outcome submission. | The shared engine follows the XML `onErrorStep`; the client cannot use omission to claim a normal result. | Accepted fail-safe bias. It can create needless manual referrals; production should require a server-recorded failure receipt when the server is reachable. |
| The active XML is edited without a version bump. | Day 1 cannot distinguish it from the reviewed release. | Repository review is the only control. Production needs signed, content-addressed releases and exact version retrieval. |
| A compatible-major model implementation changes after workflow approval. | Day 1 records the resolved mock version but does not bind approval to its artifact. | Safe only for the bundled deterministic mock. Production publication pins a model digest and reapproves model changes. |
| A model adapter returns a missing, unknown or malformed result. | The API rejects it before storage and returns an AI error. | Handled for the compact Day 1 contracts. A production descriptor must also be versioned and pinned to the approved model artifact. |
| A client attaches a file to the questionnaire AI step. | The server rejects the file because that step has no `bind="file"` input. | Handled at the trust boundary. |
| A workflow contains an unknown step, condition source or executable text. | Validation fails before the workflow is served. | Handled by fail-closed parsing and allow-listed rendering. |
| SQLite is locked, full or unavailable. | The request must not report success before the transaction commits. Day 1 returns an error and preserves retry safety. | Mitigated. Metrics, alerting, backup and recovery are deferred. |
| The page is refreshed, closed or lost after answers are entered. | The in-memory encounter and retry key are lost. | Deferred. IndexedDB drafts and an outbox are the next field-resilience step. |
