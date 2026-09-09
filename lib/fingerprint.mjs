// Stable fingerprint of a PAL payload, so an identical config can be reused
// instead of creating a duplicate PAL on every run.
//
// The hash is stored in the PAL's own name (`... #<hash>`) rather than in a
// local cache file. That way reuse survives a fresh clone, a second machine,
// or a PAL someone deleted from the portal -- the account itself is the
// source of truth.

import { createHash } from 'node:crypto';

// JSON.stringify preserves insertion order, so two payloads that differ only
// in key order would hash differently. Sort every object key first.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, canonicalize(value[k])]),
    );
  }
  return value;
}

export const FINGERPRINT_LEN = 12;

/** Short hex digest of a PAL payload, ignoring `pal_name`. */
export function fingerprint(payload) {
  // pal_name is excluded because it *carries* the fingerprint -- including it
  // would be circular. It is also cosmetic, so two runs that differ only by
  // filename should still share a PAL.
  const { pal_name: _ignored, ...rest } = payload;
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(rest)))
    .digest('hex')
    .slice(0, FINGERPRINT_LEN);
}

// Tavus caps pal_name, so the label is trimmed to leave room for the suffix.
const MAX_PAL_NAME = 60;

export function palNameWithFingerprint(label, hash) {
  const suffix = ` #${hash}`;
  return label.slice(0, MAX_PAL_NAME - suffix.length).trimEnd() + suffix;
}

export function palNameHasFingerprint(palName, hash) {
  return typeof palName === 'string' && palName.endsWith(`#${hash}`);
}
