import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { freshLibrary, tempDir, cleanup } from './helpers/common.js'
import {
  PROJECT_SCHEMA_VERSION,
  createProject,
  normalizeTargets,
  openProject,
} from '../src/kernel/project.js'
import {
  entityIdFor,
  entityKeyIdentifier,
  isValidUscc,
  normalizeIdentifier,
  normalizeIdentifiers,
  normalizeListingStatus,
  normalizeTarget,
  primaryIdentifier,
  subjectIdForTarget,
  usccCheckChar,
} from '../src/kernel/subjects.js'
import { subjectIdFor } from '../src/util/ids.js'
import { migrateLegacyProject } from '../src/kernel/migrate.js'
import { listArtifacts } from '../src/kernel/artifacts.js'

function makeUscc(seed17) {
  const check = usccCheckChar(seed17)
  assert.ok(check, `seed should yield a check char: ${seed17}`)
  return `${seed17}${check}`
}

const USCC_A = makeUscc('91310000MA1FL0000')
const USCC_B = makeUscc('91310000MA1FL0001')

test('identity: a code — stock code or USCC — never implies `listed`', () => {
  assert.equal(isValidUscc(USCC_A), true)
  assert.equal(isValidUscc(`${USCC_A.slice(0, 17)}X`), false)
  assert.equal(isValidUscc('300308'), false)

  // Legacy stock code: kept as a read-only mirror, no listing status inference.
  const stock = normalizeTargets({ target: '示例科技', code: '300308' })[0]
  assert.equal(stock.name, '示例科技')
  assert.equal(stock.code, '300308')
  assert.equal(stock.listingStatus, 'unknown')
  assert.equal(stock.identifiers.length, 1)
  assert.equal(stock.identifiers[0].scheme, 'SECURITY_TICKER')
  assert.equal(stock.identifiers[0].value, '300308')
  assert.equal(stock.identifiers[0].verificationStatus, 'unverified')
  assert.equal(stock.entityId, 'co_示例科技')

  // An explicit USCC is a subject identifier, not a listing signal.
  const withUscc = normalizeTargets({ target: '示例科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_A }] })[0]
  assert.equal(withUscc.listingStatus, 'unknown')
  assert.equal(withUscc.identifiers.length, 1)
  assert.equal(withUscc.identifiers[0].scheme, 'CN_USCC')
  assert.equal(withUscc.identifiers[0].checksum, 'valid')
  assert.notEqual(withUscc.entityId, stock.entityId)
  assert.match(withUscc.entityId, /^co_[0-9a-f]{24}$/)

  // Listing status comes from the user/evidence only.
  assert.equal(normalizeTargets({ target: 'X', listingStatus: 'listed' })[0].listingStatus, 'listed')
  assert.equal(normalizeTargets({ target: 'X', listingStatus: '未上市' })[0].listingStatus, 'unlisted')
  assert.equal(normalizeListingStatus(undefined), 'unknown')
  assert.equal(normalizeListingStatus('something-else'), 'unknown')
})

test('identity: identifiers normalize legacy labels and keep unknown schemes typed', () => {
  const legacy = normalizeIdentifier({ kind: '统一社会信用代码', value: USCC_A, jurisdiction: 'CN' })
  assert.equal(legacy.scheme, 'CN_USCC')
  assert.equal(legacy.verificationStatus, 'unverified')

  const untyped = normalizeIdentifier('ABC-123')
  assert.equal(untyped.scheme, 'UNTYPED_EXTERNAL_IDENTIFIER')
  assert.equal(untyped.value, 'ABC-123')

  const list = normalizeIdentifiers([
    { scheme: 'SECURITY_TICKER', value: '300308' },
    { scheme: 'CN_USCC', value: USCC_A },
    { scheme: 'CN_USCC', value: USCC_A },
  ])
  assert.equal(list.length, 2)
  // A security ticker is never the entity key.
  assert.equal(primaryIdentifier(list).scheme, 'CN_USCC')
  assert.equal(entityKeyIdentifier([{ scheme: 'SECURITY_TICKER', value: '300308' }]), null)
  assert.equal(primaryIdentifier([{ scheme: 'SECURITY_TICKER', value: '300308' }]).value, '300308')
})

test('identity: only-name projects work and persist a stable entityId', async (t) => {
  const library = await freshLibrary()
  const root = tempDir('only-name')
  t.after(() => cleanup(root))

  await createProject({ target: '示例科技', root, preset: 'skill-only', asOf: '2026-09-30', executor: 'fixture', library })
  const opened = await openProject(root)
  assert.equal(opened.project.schemaVersion, PROJECT_SCHEMA_VERSION)
  assert.equal(opened.project.schemaVersion, 2)
  const target = opened.project.targets[0]
  assert.equal(target.name, '示例科技')
  assert.equal(target.inputName, '示例科技')
  assert.equal(target.entityId, 'co_示例科技')
  assert.equal(target.listingStatus, 'unknown')
  assert.deepEqual(target.identifiers, [])

  // Persisted, not recomputed on reopen.
  const reopened = await openProject(root)
  assert.equal(reopened.project.targets[0].entityId, target.entityId)

  // The roster bootstrap carries the same subject key.
  const artifacts = await listArtifacts(root)
  const roster = artifacts.find((artifact) => artifact.type === 'company.roster')
  assert.ok(roster)
  assert.equal(roster.data.targets[0].entityId, target.entityId)
  assert.equal(roster.data.targets[0].listingStatus, 'unknown')
})

test('identity: entityId is deterministic and identifier-seeded', () => {
  const a = entityIdFor({ name: '示例科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_A }] })
  const b = entityIdFor({ name: '示例科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_A.toUpperCase() }] })
  const other = entityIdFor({ name: '示例科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_B }] })
  assert.equal(a, b)
  assert.notEqual(a, other)
  assert.notEqual(a, 'co_示例科技')

  // Jurisdiction participates in the name seed off-CN.
  const cn = entityIdFor({ name: 'Example Ltd', jurisdiction: 'CN' })
  const hk = entityIdFor({ name: 'Example Ltd', jurisdiction: 'HK' })
  assert.notEqual(cn, hk)

  // Same-name targets with different identifiers are distinct subjects.
  const targets = normalizeTargets({
    targets: [
      { name: '同名科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_A }] },
      { name: '同名科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_B }] },
    ],
  })
  assert.equal(targets.length, 2)
  assert.notEqual(targets[0].entityId, targets[1].entityId)
  // Exact duplicates still collapse.
  const duplicated = normalizeTargets({
    targets: [
      { name: '同名科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_A }] },
      { name: '同名科技', identifiers: [{ scheme: 'CN_USCC', value: USCC_A }] },
    ],
  })
  assert.equal(duplicated.length, 1)
})

test('identity: subjectIdForTarget keeps v1 legacy keys and uses entityId for v2', () => {
  const target = { name: '示例科技', entityId: 'co_0123456789abcdef01234567' }
  assert.equal(subjectIdForTarget(target, { schemaVersion: 2 }), target.entityId)
  assert.equal(subjectIdForTarget(target, { schemaVersion: 1 }), subjectIdFor('co', '示例科技'))
  assert.equal(subjectIdForTarget(target, {}), subjectIdFor('co', '示例科技'))
})

test('identity: v1 projects still open, unsupported versions are rejected', async (t) => {
  const library = await freshLibrary()
  const root = tempDir('v1-open')
  t.after(() => cleanup(root))
  await createProject({ target: '示例科技', root, preset: 'skill-only', asOf: '2026-09-30', executor: 'fixture', library })

  const file = join(root, 'project.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.schemaVersion = 1
  manifest.targets = [{ name: '示例科技', code: '300308' }]
  await writeFile(file, JSON.stringify(manifest), 'utf8')

  const opened = await openProject(root)
  assert.equal(opened.project.schemaVersion, 1)
  assert.equal(opened.project.targets[0].code, '300308')
  assert.equal(opened.project.targets[0].identifiers, undefined)

  manifest.schemaVersion = 3
  await writeFile(file, JSON.stringify(manifest), 'utf8')
  await assert.rejects(() => openProject(root), (error) => error.code === 'schema_version')
})

test('identity: migration adds entityId/identifiers/listingStatus without re-keying', async (t) => {
  const library = await freshLibrary()
  const root = tempDir('legacy-identity')
  t.after(() => cleanup(root))
  await cp(join(import.meta.dirname, 'fixtures', 'legacy-project'), root, { recursive: true })

  await migrateLegacyProject({ root, library, targetName: '示例科技' })
  const manifest = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  const target = manifest.targets[0]
  assert.equal(target.name, '示例科技')
  assert.equal(target.entityId, 'co_示例科技')
  assert.equal(target.entityId, subjectIdFor('co', '示例科技'))
  assert.deepEqual(target.identifiers, [])
  assert.equal(target.listingStatus, 'unknown')

  // Imported artifacts keep the legacy subject key — no re-key.
  const artifacts = await listArtifacts(root)
  const map = artifacts.find((artifact) => artifact.type === 'investment.map')
  assert.ok(map)
  assert.equal(map.subjectId, target.entityId)
})
