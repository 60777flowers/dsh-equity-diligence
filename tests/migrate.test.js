import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { freshLibrary, tempDir, cleanup } from './helpers/common.js'
import { migrateLegacyProject } from '../src/kernel/migrate.js'
import { listArtifacts } from '../src/kernel/artifacts.js'

test('migration: legacy ledgers become draft artifacts and original files are untouched', async (t) => {
  const library = await freshLibrary()
  const root = tempDir('legacy')
  t.after(() => cleanup(root))
  await cp(join(import.meta.dirname, 'fixtures', 'legacy-project'), root, { recursive: true })
  const original = await readFile(join(root, '01_平台收集', '平台汇总_工作稿.md'), 'utf8')
  const result = await migrateLegacyProject({ root, library, targetName: '示例科技' })
  assert.equal(result.ok, true)
  assert.equal(result.imported.platforms, 2)
  assert.equal(result.imported.results, 1)
  assert.equal(result.imported.deliverables, 1)
  const artifacts = await listArtifacts(root)
  assert.ok(artifacts.some((artifact) => artifact.type === 'investment.map' && artifact.status === 'draft'))
  assert.ok(artifacts.some((artifact) => artifact.type === 'structured.findings' && artifact.producedBy.actor === 'import'))
  assert.ok(artifacts.some((artifact) => artifact.type === 'report.deliverable' && artifact.status === 'draft'))
  assert.equal(await readFile(join(root, '01_平台收集', '平台汇总_工作稿.md'), 'utf8'), original)
  assert.ok((await stat(join(root, 'project.json'))).isFile())
})

test('migration: dry run does not write project.json', async (t) => {
  const library = await freshLibrary()
  const root = tempDir('legacy-dry')
  t.after(() => cleanup(root))
  await cp(join(import.meta.dirname, 'fixtures', 'legacy-project'), root, { recursive: true })
  const result = await migrateLegacyProject({ root, library, targetName: '示例科技', dryRun: true })
  assert.equal(result.dryRun, true)
  await assert.rejects(() => stat(join(root, 'project.json')))
})
