# Architecture Diagram

Symbols name component types, color marks boundaries, and arrows show runtime flow. Longer explanations stay in the design documents.

## System architecture

- [PNG export](screening-runtime-architecture.png)

| Visual cue | Meaning |
|---|---|
| Orange | People and field input outside the application trust boundary |
| Blue | Code and state on the health worker's device |
| Teal | Server-side execution inside the Node API container |
| Purple | Workflow configuration and mounted data |
| Slate dashed boundary | Docker, bind-mount or named-volume boundary |
| API glyph in a hexagon | Public HTTP interface; the label gives its method and job |
| Repeated gear in a hexagon | One shared Engine 1 package used at four call sites; purple outlines mark server reads from mounted XML |
| Data parallelogram | Submitted payload or canonical model input |
| Fingerprint document | Photo evidence reduced to SHA-256 and size metadata; it does not enter the mock model |
| Diamond | Branch, idempotency or trust decision |
| Multiple documents / cylinder | Mounted workflow XML / durable SQLite file |
| Red / green path | Rejected request / accepted durable write |

Every browser exchange passes through Nginx. Double-headed arrows include the response, so XML, AI results and outcome receipts return through the same proxy path.

The bottom lane reads left to right: outcome API, key plus payload-hash lookup, trusted Engine 1 recomputation, claimed-path comparison, then atomic commit. An exact key replay exits before recomputation; a changed payload returns `409`; a semantic mismatch returns `422`.

One purple configuration line shows the mounted XML source; purple outlines carry that meaning to the other server-side Engine 1 call sites without crossing the runtime lanes. The submission UUID stays on the device and joins the answers, evaluation IDs and claimed terminal step at submission.

Day 1 includes this runtime view. Sequence, data-model and renderer-state views are deferred until they answer a specific review question.
