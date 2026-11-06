import { join } from 'node:path'

import { EquityError, newId } from '../util/json.js'
import { appendJsonLine, ensureDir, readJsonLines } from '../util/fs.js'
import { nowIso } from '../util/time.js'

function issuesFile(root) {
  return join(root, '.equity', 'issues.jsonl')
}

/** Append one issue. */
export async function createIssue(root, issue) {
  const record = {
    issueId: issue.issueId ?? newId('iss'),
    projectId: issue.projectId ?? null,
    runId: issue.runId ?? null,
    unitId: issue.unitId ?? null,
    artifactId: issue.artifactId ?? null,
    type: issue.type ?? 'general',
    severity: issue.severity ?? 'medium',
    status: issue.status ?? 'open',
    title: issue.title ?? '未命名议题',
    detail: issue.detail ?? '',
    options: issue.options ?? [],
    decision: issue.decision ?? null,
    reason: issue.reason ?? null,
    createdAt: issue.createdAt ?? nowIso(),
    decidedAt: null,
    decidedBy: null,
  }
  await ensureDir(join(root, '.equity'))
  await appendJsonLine(issuesFile(root), record)
  return record
}

/** List issues, last record per id wins. */
export async function listIssues(root, filter = {}) {
  const { lines } = await readJsonLines(issuesFile(root))
  const map = new Map()
  for (const line of lines) map.set(line.issueId, line)
  let out = [...map.values()]
  if (filter.status) out = out.filter((issue) => issue.status === filter.status)
  if (filter.runId) out = out.filter((issue) => issue.runId === filter.runId)
  if (filter.artifactId) out = out.filter((issue) => issue.artifactId === filter.artifactId)
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/** Decide one issue by id. */
export async function decideIssue(root, issueId, { decision, reason, decidedBy = 'user' }) {
  const issues = await listIssues(root)
  const current = issues.find((issue) => issue.issueId === issueId)
  if (!current) throw new EquityError('issue_missing', `议题不存在：${issueId}`)
  if (!['accept', 'dismiss', 'defer', 'waive', 'reject'].includes(decision)) {
    throw new EquityError('bad_decision', `不支持的裁决：${decision}`)
  }
  const next = {
    ...current,
    status: decision === 'defer' ? 'deferred' : decision === 'accept' ? 'accepted' : decision === 'dismiss' ? 'dismissed' : decision === 'waive' ? 'waived' : 'rejected',
    decision,
    reason: reason ?? '',
    decidedAt: nowIso(),
    decidedBy,
  }
  await appendJsonLine(issuesFile(root), next)
  return next
}
