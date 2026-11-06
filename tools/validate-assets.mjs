#!/usr/bin/env node
import { loadLibrary, loadPreset, listPresets } from '../src/kernel/registry.js'
import { compilePlaybook } from '../src/kernel/playbook.js'

const library = await loadLibrary({ strict: true })
const errors = []
const warnings = []
for (const module of library.moduleList) {
  if (!module.validation.valid) errors.push(...module.validation.errors)
  warnings.push(...module.validation.warnings)
  if (!module.skill.trim()) errors.push({ code: 'missing_skill', moduleId: module.id })
  if (!module.prompts.task.trim()) errors.push({ code: 'missing_task', moduleId: module.id })
  try {
    JSON.parse(JSON.stringify(module.gates))
  } catch (error) {
    errors.push({ code: 'bad_gates', moduleId: module.id, message: error.message })
  }
}
const presets = await listPresets()
for (const preset of presets) {
  const playbook = await loadPreset(preset.name)
  const result = compilePlaybook({ library, project: { projectId: 'eq_validate', budget: {} }, playbook })
  if (!result.ok) errors.push(...result.errors)
  console.log(`${preset.name}: ${result.ok ? 'ok' : 'FAIL'} ${result.plan?.steps.length ?? 0} steps`)
}
console.log(JSON.stringify({
  types: library.typeList.length,
  modules: library.moduleList.length,
  moduleErrors: library.errors.length,
  errors: errors.length,
  warnings: warnings.length,
}, null, 2))
if (errors.length || library.errors.length) {
  console.error(JSON.stringify({ library: library.errors, errors }, null, 2))
  process.exit(1)
}
