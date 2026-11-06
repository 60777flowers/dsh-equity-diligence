#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compilePlaybook } from '../src/kernel/playbook.js'
import { loadLibrary, loadPreset } from '../src/kernel/registry.js'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const files = ['client.js']
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.name.endsWith('.js')) files.push(full)
  }
}
await walk(join(root, 'src'))
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' })
}

const library = await loadLibrary({ strict: true })
const errors = []
// 文档一致性（目录↔标题、锚点、计数表述）。失败时子进程会打印明细并以非 0 退出。
try {
  execFileSync(process.execPath, [join(root, 'tools', 'check-docs.mjs')], { stdio: 'inherit' })
} catch {
  errors.push({ code: 'docs_inconsistent', message: '文档一致性检查失败，见上方输出' })
}
for (const name of ['skill-only', 'quick', 'standard', 'deep', 'generic']) {
  const playbook = await loadPreset(name)
  const result = compilePlaybook({ library, project: { projectId: 'eq_check', budget: {} }, playbook })
  if (!result.ok) errors.push(...result.errors)
  console.log(`${name}: ${result.ok ? 'ok' : 'FAIL'} (${result.plan?.steps.length ?? 0} steps)`)
}
if (library.errors.length || errors.length) {
  console.error(JSON.stringify({ library: library.errors, presets: errors }, null, 2))
  process.exit(1)
}
console.log(`syntax ok (${files.length} js files); ${library.typeList.length} types; ${library.moduleList.length} modules`)
