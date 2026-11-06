import { EquityError } from '../util/json.js'
import { listArtifacts } from '../kernel/artifacts.js'
import { runTriggers, triggerFlags, ddRequestsFrom } from '../kernel/triggers.js'
import { buildDeliverable } from '../builders/package.js'

/**
 * Routes deterministic modules to code, everything else to the configured
 * research executor. This keeps builders out of the model's hands.
 */
export class CompositeExecutor {
  constructor({ primary, library, root, project, playbook, plan, run, signoff = {} }) {
    this.primary = primary
    this.library = library
    this.root = root
    this.project = project
    this.playbook = playbook
    this.plan = plan
    this.run = run
    this.signoff = signoff
    this.name = `composite:${primary.name}`
  }

  async execute(context) {
    const { step } = context
    if (step.moduleId === 'builtin/red-flags') return this.executeRedFlags(context)
    if (step.moduleId === 'builtin/deliverable') return this.executeDeliverable(context)
    return this.primary.execute(context)
  }

  async executeRedFlags({ step, unit }) {
    const artifacts = await listArtifacts(this.root)
    const triggers = runTriggers(artifacts)
    const flags = triggerFlags(triggers)
    const openQuestions = artifacts.flatMap((artifact) => artifact.openQuestions ?? [])
    const ddRequests = ddRequestsFrom({ triggers, openQuestions })
    return {
      artifacts: [{
        type: 'risk.redflags',
        subjectId: unit.subjectId,
        partitionKey: unit.partitionKey,
        output: {
          asOf: this.project.engagement?.asOf,
          openQuestions,
          flags,
          sourceCoverage: { queries: [], databases: [], retrievedAt: new Date().toISOString(), limitations: [] },
          claims: [],
          evidence: [],
          data: {
            flags,
            claimMatrix: [],
            ddRequests,
            triggerResults: triggers,
          },
        },
      }],
      tokens: 0,
      toolCalls: 0,
      searches: [],
    }
  }

  async executeDeliverable({ unit }) {
    const result = await buildDeliverable({
      root: this.root,
      library: this.library,
      project: this.project,
      playbook: this.playbook,
      plan: this.plan,
      run: this.run,
      template: 'standard',
      signoff: this.signoff,
    })
    if (!result.qa.passed) {
      throw new EquityError('delivery_qa_failed', `交付体检未通过：${result.qa.blocking.map((item) => item.message).join('；')}`, {
        blocking: result.qa.blocking,
        outDir: result.outDir,
      })
    }
    const artifacts = await listArtifacts(this.root)
    const redflags = artifacts.find((artifact) => artifact.type === 'risk.redflags')
    const ddRequests = result.ddRequests?.length ? result.ddRequests : redflags?.data?.ddRequests ?? []
    const findingsById = new Map((result.findings ?? []).map((finding) => [finding.findingId, finding]))
    const summaryFindings = result.manifest?.cellMap?.map((item, index) => {
      const findingId = item.location?.split('#').pop() ?? `F${index + 1}`
      const source = findingsById.get(findingId)
      return {
        findingId,
        fact: source?.fact ?? item.value ?? '',
        impact: source?.impact ?? '',
        evidenceStrength: source?.evidenceStrength ?? '',
        materiality: source?.materiality ?? 'attention',
        nextStep: source?.nextStep ?? '',
        claimId: item.claimId ?? source?.claimId ?? null,
        artifactId: item.artifactId ?? source?.artifactId ?? null,
      }
    }) ?? []
    const files = result.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      kind: file.kind,
      size: file.size,
    }))
    const signoff = { ...(result.manifest.signoff ?? {}) }
    if (!signoff.signedAt) delete signoff.signedAt
    const pins = artifacts
      .filter((artifact) => !['report.deliverable', 'dd.request_list'].includes(artifact.type))
      .map((artifact) => ({
        artifactId: artifact.id,
        type: artifact.type,
        kind: 'input',
        revision: artifact.revision,
        contentHash: artifact.contentHash,
        fieldPaths: [],
      }))
    return {
      artifacts: [
        {
          type: 'report.deliverable',
          subjectId: 'project',
          partitionKey: '_default',
          derivedFrom: pins,
          output: {
            asOf: this.project.engagement?.asOf,
            openQuestions: [],
            flags: result.qa.warnings.map((warning) => ({ level: 'attention', rule: warning.id, desc: warning.message })),
            sourceCoverage: { queries: [], databases: [], retrievedAt: new Date().toISOString(), limitations: [] },
            claims: [],
            evidence: [],
            data: {
              generatedAt: result.manifest.generatedAt,
              files,
              summaryFindings,
              cellMap: result.manifest.cellMap ?? [],
              qa: { blocking: result.qa.blocking.length, warnings: result.qa.warnings.length, passed: result.qa.passed },
              signoff,
            },
          },
        },
        {
          type: 'dd.request_list',
          subjectId: unit.subjectId,
          partitionKey: unit.partitionKey,
          derivedFrom: pins,
          output: {
            asOf: this.project.engagement?.asOf,
            openQuestions: [],
            flags: [],
            sourceCoverage: { queries: [], databases: [], retrievedAt: new Date().toISOString(), limitations: [] },
            claims: [],
            evidence: [],
            data: { items: ddRequests },
          },
        },
      ],
      tokens: 0,
      toolCalls: 0,
      searches: [],
    }
  }
}
