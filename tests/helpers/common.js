import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadLibrary } from '../../src/kernel/registry.js'
import { createProject } from '../../src/kernel/project.js'

export const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
export const fixturesDir = join(repoRoot, 'tests', 'fixtures')
export const testHome = join(repoRoot, 'tests', '.tmp', 'home')

export function setTestHome() {
  process.env.DSH_HOME = testHome
  return testHome
}

export function tempDir(name) {
  return join(repoRoot, 'tests', '.tmp', `${name}-${randomUUID().slice(0, 8)}`)
}

export async function freshLibrary() {
  setTestHome()
  await mkdir(join(testHome, 'modules'), { recursive: true })
  return loadLibrary({ strict: true, userModulesDir: join(testHome, 'modules') })
}

export async function freshProject(name, options = {}) {
  const library = options.library ?? await freshLibrary()
  const root = options.root ?? tempDir(name)
  await rm(root, { recursive: true, force: true })
  const opened = await createProject({
    target: options.target ?? '示例科技',
    root,
    preset: options.preset ?? 'skill-only',
    asOf: options.asOf ?? '2026-09-30',
    executor: options.executor ?? 'fixture',
    library,
    ...options,
  })
  return { library, ...opened }
}

export async function readFixture(file) {
  return JSON.parse(await readFile(join(fixturesDir, file), 'utf8'))
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true })
}

export function playbook(modules, overrides = {}) {
  return {
    apiVersion: 'equity.playbook/v1',
    id: 'test-playbook',
    name: '测试方案',
    version: '1.0.0',
    preset: 'skill-only',
    targets: { scope: 'company', from: 'company.roster' },
    stages: [
      { id: 'identity' }, { id: 'ownership' }, { id: 'people' }, { id: 'business' },
      { id: 'tech' }, { id: 'finance' }, { id: 'risk' }, { id: 'market' },
      { id: 'assessment' }, { id: 'delivery' }, { id: 'investigation' },
    ],
    modules,
    budget: { maxTokens: 1_000_000, maxWallClockMin: 60 },
    ...overrides,
  }
}
