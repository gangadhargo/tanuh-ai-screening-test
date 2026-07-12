import { createHash } from 'node:crypto';

// Canonical JSON (sorted keys) so the same payload always hashes the same,
// regardless of client-side property order.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function payloadHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
