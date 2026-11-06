import test from 'node:test'
import assert from 'node:assert/strict'

import { registerSkill } from '../src/index.js'

test('skill: registers a runtime skill with the required source and usable body', async () => {
  let registered
  const dispose = () => {}
  const ctx = {
    skills: {
      register(skill) {
        registered = skill
        return dispose
      },
    },
  }
  const result = await registerSkill(ctx)
  assert.equal(result, dispose)
  assert.equal(registered.name, 'equity-diligence')
  assert.equal(registered.source, 'runtime')
  assert.equal(registered.invocation.modelInvocable, true)
  assert.equal(registered.invocation.userInvocable, true)
  assert.ok(registered.content.length > 500)
  assert.match(registered.content, /一级市场/)
})
