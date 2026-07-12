// Runtime errors live in one module so every engine consumer uses the same
// instanceof checks.
export class WorkflowParseError extends Error {}
export class EngineError extends Error {}
