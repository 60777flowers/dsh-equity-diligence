import { join } from 'node:path'

import { canonicalJson, semanticHash, sha256 } from '../util/json.js'
import { atomicWriteJson, readJson } from '../util/fs.js'
import { nowIso } from '../util/time.js'

export const BUILDER_VERSION = '0.1.0'

/** Build a content-addressed run snapshot. */
export function buildSnapshot({ project, playbook, plan, library, engine = {}, sourceProviders = {} }) {
  const modules = plan.steps.map((step) => ({
    instanceId: step.instanceId,
    moduleId: step.moduleId,
    moduleVersion: step.moduleVersion,
    moduleHash: step.moduleHash,
    templateSha: step.templateSha,
    params: step.params,
    tools: step.tools,
    outputs: step.outputs,
  }))
  const schemaHashes = {}
  for (const step of plan.steps) {
    for (const output of step.outputs ?? []) {
      const meta = library.types.get(output.type)
      if (meta) schemaHashes[output.type] = semanticHash(meta.schema)
    }
  }
  const base = {
    schemaVersion: 1,
    createdAt: nowIso(),
    projectId: project?.projectId ?? null,
    playbook: {
      id: playbook.id,
      version: playbook.version,
      hash: semanticHash(playbook),
    },
    plan: {
      snapshotHash: plan.snapshotHash,
      steps: plan.steps,
      edges: plan.edges,
      budget: plan.budget,
    },
    modules,
    schemaHashes,
    engagement: project?.engagement ?? null,
    targets: project?.targets ?? [],
    clientProfileHash: project?.clientProfile?.sha256 ?? null,
    engine: {
      executor: engine.executor ?? project?.engine?.executor ?? 'private-agent',
      fallback: engine.fallback ?? project?.engine?.fallback ?? 'native-loop',
      provider: engine.provider ?? project?.engine?.provider ?? null,
      model: engine.model ?? project?.engine?.model ?? null,
      reasoningEffort: engine.reasoningEffort ?? null,
      temperature: engine.temperature ?? null,
    },
    sourceProviders,
    builderVersion: BUILDER_VERSION,
  }
  base.snapshotHash = semanticHash(base)
  return base
}

/** Persist the snapshot at the start of a run. */
export async function writeSnapshot(runDir, snapshot) {
  await atomicWriteJson(join(runDir, 'plan.snapshot.json'), snapshot)
  return snapshot
}

/** Read and hash-check a snapshot. */
export async function readSnapshot(runDir) {
  const snapshot = await readJson(join(runDir, 'plan.snapshot.json'), null)
  if (!snapshot) return null
  const copy = { ...snapshot }
  delete copy.snapshotHash
  const actual = semanticHash(copy)
  return { ...snapshot, verified: actual === snapshot.snapshotHash, actualHash: actual }
}

/** Stable lock hash of a snapshot. */
export function snapshotLockHash(snapshot) {
  return sha256(canonicalJson(snapshot))
}
