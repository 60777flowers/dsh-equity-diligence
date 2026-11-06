import { createHash } from 'node:crypto'

import { newId } from './json.js'

/** Slug for project directories; keeps CJK and normalises punctuation. */
export function slugify(value, fallback = 'project') {
  const text = String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 48)
  return text || fallback
}

/** Project id with a local date prefix. */
export function projectIdFor(name, date = new Date()) {
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  return `eq_${stamp}_${slugify(name)}`
}

/** Stable short id derived from a semantic key (for deterministic fixtures). */
export function stableId(prefix, key) {
  const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 24)
  return `${prefix}_${digest}`
}

/** Random ids for user-created records. */
export const ids = {
  artifact: () => newId('art'),
  evidence: () => newId('ev'),
  claim: () => newId('cl'),
  run: () => newId('run'),
  unit: () => newId('unit'),
  issue: () => newId('iss'),
  review: () => newId('rev'),
  deliverable: () => newId('del'),
  trigger: () => newId('trg'),
  receipt: () => newId('rcp'),
}

/** Deterministic id for a unit key. */
export function unitIdFor(unitKey) {
  return stableId('unit', unitKey)
}

/** Normalize a subject id: keep existing ids, otherwise slug with prefix. */
export function subjectIdFor(kind, value) {
  const text = String(value ?? '').trim()
  if (!text) return `${kind}_unknown`
  if (/^[a-z]+_[a-z0-9][a-z0-9_-]*$/i.test(text)) return text
  return `${kind}_${slugify(text, 'unknown')}`
}
