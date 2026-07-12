export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function listWorkflows() {
  const response = await fetch('/api/v1/workflows');
  if (!response.ok) throw new ApiError(response.status, 'list-failed');
  return response.json();
}

export async function fetchWorkflowXml(id) {
  const response = await fetch(`/api/v1/workflows/${encodeURIComponent(id)}`);
  if (!response.ok) throw new ApiError(response.status, 'workflow-fetch-failed');
  return response.text();
}

export async function evaluate(metadata, image) {
  let response;
  if (image) {
    const form = new FormData();
    form.set('metadata', JSON.stringify(metadata));
    form.set('image', image);
    response = await fetch('/api/v1/ai/evaluations', { method: 'POST', body: form });
  } else {
    response = await fetch('/api/v1/ai/evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }
  if (!response.ok) {
    const body = await parseJson(response);
    throw new ApiError(response.status, String(body.error ?? 'ai-error'), String(body.detail ?? ''));
  }
  return response.json();
}

// Retrying the exact request with the same key is safe. The backend stores it
// once and replays the same receipt.
export async function submitOutcome(body, idempotencyKey) {
  const response = await fetch('/api/v1/outcomes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
  const parsed = await parseJson(response);
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    throw new ApiError(response.status, String(parsed.error ?? 'temporarily-unavailable'), String(parsed.detail ?? ''));
  }
  return { status: response.status, body: parsed };
}
