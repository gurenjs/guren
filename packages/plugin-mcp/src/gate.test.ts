import { describe, test, expect } from 'bun:test'
import { Router, deriveAgentTools, type DerivedAgentTool } from '@guren/core'

import { gateToolCall } from './gate'

function tools(): { read: DerivedAgentTool; write: DerivedAgentTool; approval: DerivedAgentTool } {
  const router = new Router()
  const handler = () => new Response('ok')
  router.get('/posts', handler).name('posts.index').agent({})
  router.post('/posts', handler).name('posts.store').agent({})
  router.delete('/posts/:id', handler).name('posts.destroy').agent({ approval: 'required' })
  const derived = deriveAgentTools(router.definitions()).tools
  const byName = new Map(derived.map((tool) => [tool.toolName, tool]))
  return {
    read: byName.get('posts.index')!,
    write: byName.get('posts.store')!,
    approval: byName.get('posts.destroy')!,
  }
}

describe('gateToolCall', () => {
  test('should allow a tool the scopes grant', () => {
    expect(gateToolCall(tools().write, ['tool:posts.store'])).toEqual({ allowed: true })
  })

  test('should deny with reason scope when no entry grants the tool', () => {
    const verdict = gateToolCall(tools().write, ['tools:read', '*'])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toBe('scope')
  })

  test('should judge tools:read by the resolved read-only annotation', () => {
    const { read, write } = tools()
    expect(gateToolCall(read, ['tools:read']).allowed).toBe(true)
    expect(gateToolCall(write, ['tools:read']).allowed).toBe(false)
  })

  test('should deny an approval-required tool even when scopes grant it', () => {
    const verdict = gateToolCall(tools().approval, ['tools:*'])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toBe('approval')
  })

  test('should report scope before approval, so probes cannot map approval gates', () => {
    const verdict = gateToolCall(tools().approval, [])
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toBe('scope')
  })
})
