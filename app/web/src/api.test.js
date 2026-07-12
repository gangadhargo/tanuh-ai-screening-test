import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, submitOutcome } from './api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('outcome retry classification', () => {
  it('keeps a temporary server failure on the retry path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'temporarily-unavailable' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(submitOutcome({ encounterId: 'enc-1' }, 'submission-key'))
      .rejects.toBeInstanceOf(ApiError);
  });

  it('returns a permanent domain rejection to the runner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid-answers' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    )));

    await expect(submitOutcome({ encounterId: 'enc-1' }, 'submission-key'))
      .resolves.toMatchObject({ status: 422, body: { error: 'invalid-answers' } });
  });
});
