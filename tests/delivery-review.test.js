import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { compilePlaybook } from '../src/kernel/playbook.js'
import { startRun } from '../src/kernel/runner.js'
import { createExecutor } from '../src/engines/index.js'
import { artifactDir, listArtifacts, setArtifactStatus } from '../src/kernel/artifacts.js'
import { buildDeliverable } from '../src/builders/package.js'
import { repoRoot, freshProject, cleanup, playbook, tempDir } from './helpers/common.js'

const execFileAsync = promisify(execFile)
const PLACEHOLDER = '未提供/not_reviewed'

const PY_READ = String.raw`
import json
import sys
import openpyxl

sys.stdout.reconfigure(encoding="utf-8")
result = {"sheets": [], "rows": {}, "checkup": {}}
workbook = openpyxl.load_workbook(sys.argv[1], read_only=True)
result["sheets"] = list(workbook.sheetnames)
for name in ("02_主体与股权", "03_业务与技术", "04_财务", "05_风险", "3-合作基金-主导LP"):
    if name not in workbook.sheetnames:
        continue
    sheet = workbook[name]
    result["rows"][name] = [
        ["" if value is None else str(value) for value in row]
        for row in sheet.iter_rows(min_row=3, values_only=True)
    ]
if "10_体检单" in workbook.sheetnames:
    sheet = workbook["10_体检单"]
    for row in sheet.iter_rows(min_row=3, values_only=True):
        result["checkup"][str(row[0] or "")] = str(row[1] or "")
print(json.dumps(result, ensure_ascii=False))
`

async function readWorkbook(file) {
  const { stdout } = await execFileAsync('python', ['-c', PY_READ, file], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  return JSON.parse(stdout)
}

async function runPythonCheck(deliveryDir) {
  const jsonFile = join(deliveryDir, '.check-deliverable.json')
  let failed = false
  try {
    await execFileAsync('python', ['python/check_deliverable.py', '--dir', deliveryDir, '--json', jsonFile], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    if (error?.code !== 1) failed = true
  }
  assert.equal(failed, false, 'check_deliverable.py 不能崩溃')
  return JSON.parse(await readFile(jsonFile, 'utf8'))
}

async function runSkillOnly(opened) {
  const pb = playbook([
    { id: 'entity-resolution', use: 'builtin/entity-resolution@^0.1', stage: 'identity' },
    { id: 'ownership-chain', use: 'builtin/ownership-chain@^0.1', stage: 'ownership' },
    { id: 'investment-map', use: 'builtin/investment-map@^0.2', stage: 'ownership' },
    { id: 'deliverable', use: 'builtin/deliverable@^0.1', stage: 'delivery' },
  ])
  const compiled = compilePlaybook({ library: opened.library, project: opened.project, playbook: pb })
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors))
  const executor = createExecutor({
    ctx: {},
    root: opened.root,
    project: opened.project,
    library: opened.library,
    playbook: pb,
    plan: compiled.plan,
    agent: null,
    config: { executor: 'fixture' },
    fixtureDir: join(import.meta.dirname, 'fixtures', 'golden-zhongji'),
  })
  const run = await startRun({
    root: opened.root,
    library: opened.library,
    project: opened.project,
    playbook: pb,
    plan: compiled.plan,
    executor,
  })
  assert.equal(run.status, 'completed')
  return { pb, compiled, run }
}

let opened
let result
let workbook
let workbook3
let manifest

before(async () => {
  opened = await freshProject('delivery-review')
  await runSkillOnly(opened)
  result = await buildDeliverable({
    root: opened.root,
    library: opened.library,
    project: opened.project,
    playbook: opened.playbook,
    plan: { snapshotHash: 'sha256:test' },
    run: null,
    template: 'standard',
    signoff: {},
  })
  workbook = await readWorkbook(join(result.outDir, '02_综合尽调工作簿.xlsx'))
  workbook3 = await readWorkbook(join(result.outDir, '03_专项_投资版图_7+N.xlsx'))
  manifest = JSON.parse(await readFile(join(result.outDir, 'manifest.json'), 'utf8'))
})

after(async () => {
  if (opened) await cleanup(opened.root)
})

test('delivery: 14 artifacts (13 business + roster resolution) produce 14 workpapers and manifest matches the directory', async () => {
  assert.equal(manifest.counts.artifacts, 14)
  assert.equal(manifest.counts.workpapers, 14)
  const workpaperFiles = result.files.filter((file) => file.path.endsWith('workpaper.md'))
  assert.equal(workpaperFiles.length, 14)
  const paths = new Set(result.files.map((file) => file.path))
  for (const artifact of manifest.artifacts) {
    assert.ok(artifact.workpaper, `manifest artifact ${artifact.id} 缺 workpaper 字段`)
    assert.ok(paths.has(artifact.workpaper), `manifest 列出的 workpaper 不存在：${artifact.workpaper}`)
  }
  for (const name of [
    '04_工作底稿/search.ledger/co_示例科技/entity-resolution/workpaper.md',
    '04_工作底稿/source.coverage/co_示例科技/_default/workpaper.md',
    '04_工作底稿/dd.request_list/project/_default/workpaper.md',
    '04_工作底稿/investment.map/co_示例科技/_summary/workpaper.md',
    '04_工作底稿/00_索引.md',
  ]) {
    assert.ok(paths.has(name), `缺少 ${name}`)
  }
  assert.ok(paths.has('QA与签发记录.md'), 'manifest 应包含 QA与签发记录.md')
  assert.ok(![...paths].some((path) => path.endsWith('.build-input.json') || path.endsWith('.inspect.json')))
  assert.ok(![...paths].some((path) => path.startsWith('.')), '交付目录不能残留内部文件')
})

test('delivery: workbook shape is 11 + 8 sheets and 10_体检单 carries real QA', async () => {
  assert.equal(workbook.sheets.filter((name) => /^\d\d_/.test(name)).length, 11)
  assert.equal(manifest.counts.artifacts, 14)
  assert.deepEqual(result.qa.blocking, [])
  assert.equal(result.qa.passed, true)
  assert.equal(manifest.qa.passed, true)
  assert.ok(Array.isArray(manifest.qa.blocking) && Array.isArray(manifest.qa.warnings))
  assert.equal(manifest.qa.blocking.length, 0)
  assert.equal(manifest.qa.warnings.length, result.qa.warnings.length)
  assert.equal(workbook.checkup['综合结论'], '通过')
  assert.equal(workbook.checkup['QA 阻断项'], '无')
  assert.equal(workbook.checkup['QA 非阻断项'], `${result.qa.warnings.length} 条`)
  const qaRecord = await readFile(join(result.outDir, 'QA与签发记录.md'), 'utf8')
  assert.match(qaRecord, /## 结论：通过（可交付）/)
  assert.match(qaRecord, new RegExp(`check_deliverable`))
})

test('delivery: 7+N has no fabricated 否 and 02–05 never mark empty values as found', async () => {
  const entityRows = workbook3.rows['3-合作基金-主导LP'] ?? []
  assert.ok(entityRows.length >= 2, '7+N 应有实体行')
  for (const row of entityRows) {
    assert.notEqual(row[12], '否', `无控制权数据不得写「否」：${row[5]}`)
    assert.equal(row[12], PLACEHOLDER)
  }
  for (const sheetName of ['02_主体与股权', '03_业务与技术', '04_财务', '05_风险']) {
    for (const row of workbook.rows[sheetName] ?? []) {
      const [label, value, status, evidence] = row
      if (status === 'found') {
        assert.ok(!['', PLACEHOLDER, '未提供'].includes(value), `${sheetName}/${label} 空值不得 found`)
        assert.ok(!['', PLACEHOLDER, '未提供'].includes(evidence), `${sheetName}/${label} found 必须有证据`)
      }
      assert.ok(
        ['found', 'not_disclosed_after_search', 'lower_bound', 'pending_dd', 'conflict', 'not_applicable', 'not_reviewed', 'estimated'].includes(status),
        `${sheetName}/${label} 状态非法：${status}`,
      )
    }
  }
  for (const row of workbook.rows['05_风险'] ?? []) {
    assert.ok(!['无', '没有', '0'].includes(row[1]), `风险空数组不得写成「${row[1]}」`)
  }
})

test('delivery: build input keeps the real entity join key instead of entity_1', async () => {
  const entities = result.buildInput.entities
  assert.ok(Array.isArray(entities) && entities.length >= 2)
  assert.equal(entities[0].entityKey, 'co_实体甲')
  assert.equal(entities[0].joinKey, 'subjectId')
  assert.equal(entities[0].artifactSubjectId, 'co_实体甲')
  assert.equal(entities[0].entityId, 'co_实体甲')
  assert.notEqual(entities[0].entityId, 'entity_1')
  assert.equal(entities[0].fields.founderControl.status, 'not_reviewed')
  assert.equal(entities[0].fields.founderControl.value, '')
})

test('delivery: independent check_deliverable.py passes the generated package', async () => {
  const check = await runPythonCheck(result.outDir)
  assert.equal(check.passed, true, JSON.stringify(check.blocking))
  assert.equal(check.blocking.length, 0)
  assert.equal(check.stats.sheets02, 11)
  assert.equal(check.stats.workpapers, 14)
  assert.equal(check.stats.manifestFiles, result.files.length)
  assert.equal(check.stats.checkupConclusion, '通过')
})

test('delivery: empty project is blocked and the sheet says the same thing as manifest.qa', async (t) => {
  const empty = await freshProject('delivery-empty')
  t.after(() => cleanup(empty.root))
  const blocked = await buildDeliverable({
    root: empty.root,
    library: empty.library,
    project: empty.project,
    playbook: empty.playbook,
    plan: { snapshotHash: 'sha256:test' },
    run: null,
    template: 'standard',
    signoff: {},
  })
  assert.equal(blocked.qa.passed, false)
  const ids = blocked.qa.blocking.map((item) => item.id)
  assert.ok(ids.includes('no_business_artifacts'), JSON.stringify(ids))
  assert.ok(ids.includes('no_evidence'), JSON.stringify(ids))
  assert.equal(blocked.manifest.qa.passed, false)
  assert.equal(blocked.manifest.qa.blocking.length, blocked.qa.blocking.length)
  const sheet = await readWorkbook(join(blocked.outDir, '02_综合尽调工作簿.xlsx'))
  assert.equal(sheet.checkup['综合结论'], '不通过')
  assert.equal(sheet.checkup['QA 阻断项'], `有（${blocked.qa.blocking.length}）`)
  assert.equal(sheet.checkup['QA 非阻断项'], `${blocked.qa.warnings.length} 条`)
  const qaRecord = await readFile(join(blocked.outDir, 'QA与签发记录.md'), 'utf8')
  assert.match(qaRecord, /## 结论：阻断（不可交付）/)
})

test('delivery: stale artifact never enters the package and blocks QA', async () => {
  const all = await listArtifacts(opened.root)
  const target = all.find((artifact) => artifact.type === 'risk.redflags')
  assert.ok(target, 'fixture 应产出 risk.redflags')
  await setArtifactStatus(opened.root, target, 'stale')
  const rebuilt = await buildDeliverable({
    root: opened.root,
    library: opened.library,
    project: opened.project,
    playbook: opened.playbook,
    plan: { snapshotHash: 'sha256:test' },
    run: null,
    template: 'standard',
    signoff: {},
  })
  assert.equal(rebuilt.qa.passed, false)
  assert.ok(rebuilt.qa.blocking.some((item) => item.id === 'unverified_artifacts'), JSON.stringify(rebuilt.qa.blocking))
  assert.equal(rebuilt.manifest.artifacts.length, 13)
  assert.ok(!rebuilt.manifest.artifacts.some((artifact) => artifact.id === target.id))
  assert.equal(rebuilt.manifest.qa.passed, false)
  const sheet = await readWorkbook(join(rebuilt.outDir, '02_综合尽调工作簿.xlsx'))
  assert.equal(sheet.checkup['综合结论'], '不通过')
  assert.equal(sheet.checkup['QA 阻断项'], `有（${rebuilt.qa.blocking.length}）`)
})

test('delivery: a current=verified record with a missing verified pointer is blocked, not silently dropped', async () => {
  const all = await listArtifacts(opened.root)
  const target = all.find((artifact) => artifact.type === 'ownership.chain')
  assert.ok(target, 'fixture 应产出 ownership.chain')
  await rm(join(artifactDir(opened.root, target.type, target.subjectId, target.partitionKey), 'verified.json'), { force: true })
  const rebuilt = await buildDeliverable({
    root: opened.root,
    library: opened.library,
    project: opened.project,
    playbook: opened.playbook,
    plan: { snapshotHash: 'sha256:test' },
    run: null,
    template: 'standard',
    signoff: {},
  })
  assert.equal(rebuilt.qa.passed, false)
  assert.ok(
    rebuilt.qa.blocking.some((item) => item.id === 'verified_pointer_missing'),
    JSON.stringify(rebuilt.qa.blocking),
  )
  assert.ok(!rebuilt.manifest.artifacts.some((artifact) => artifact.id === target.id))
})

test('delivery: sample input renders 02 11 / 03 10 sheets with its real QA', async (t) => {
  const outDir = tempDir('delivery-sample')
  t.after(() => cleanup(outDir))
  await execFileAsync('python', [
    'python/build_workbooks.py',
    '--input', 'tests/fixtures/deliverable-input.sample.json',
    '--out', outDir,
    '--quiet',
  ], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  const sampleMap = JSON.parse(await readFile(join(outDir, 'workbook_map.json'), 'utf8'))
  assert.equal(sampleMap.sheets.filter((sheet) => sheet.file === '02').length, 11)
  assert.equal(sampleMap.sheets.filter((sheet) => sheet.file === '03').length, 10)
  const sampleWorkbook = await readWorkbook(join(outDir, '02_综合尽调工作簿.xlsx'))
  assert.equal(sampleWorkbook.checkup['综合结论'], '通过')
  assert.equal(sampleWorkbook.checkup['QA 非阻断项'], '2 条')
})
