/**
 * Shared delivery-contract helpers (kept small and dependency-free so both the
 * builder and the QA checker can import them without a cycle).
 */
import { safeSegment } from '../util/fs.js'

/** The eight delivery states (docs/实现契约.md §3.4). */
export const SIX_STATES = new Set([
  'found',
  'not_disclosed_after_search',
  'lower_bound',
  'pending_dd',
  'conflict',
  'not_applicable',
  'not_reviewed',
  'estimated',
])

/**
 * Types that are bookkeeping/outputs rather than investigated business facts.
 * A package made only of these is an empty shell and must not pass QA.
 */
export const NON_BUSINESS_ARTIFACT_TYPES = new Set([
  'company.roster',
  'search.ledger',
  'source.coverage',
  'report.deliverable',
  'dd.request_list',
])

/** Inputs whose stale/draft state must not by itself block a rebuilt package. */
export const REBUILDABLE_OUTPUT_TYPES = new Set(['report.deliverable', 'dd.request_list'])

/** Workpaper path for one artifact: type / subject / partition. */
export function workpaperRelativePath(artifact) {
  return [
    '04_工作底稿',
    safeSegment(artifact.type),
    safeSegment(artifact.subjectId),
    safeSegment(artifact.partitionKey ?? '_default'),
    'workpaper.md',
  ].join('/')
}
