import { describe, test, expect } from 'bun:test'

import { Event } from '../events/Event'
import { AgentToolDenied, AgentToolInvoked, type AgentPrincipal } from './events'

const principal: AgentPrincipal = { kind: 'user', id: 42, abilities: ['tools:read'] }

describe('AgentToolInvoked', () => {
  test('should carry the invocation record', () => {
    const event = new AgentToolInvoked(principal, 'posts.store', { title: 'Hi' }, 201, 12, 'mcp')

    expect(event.principal).toEqual(principal)
    expect(event.tool).toBe('posts.store')
    expect(event.arguments).toEqual({ title: 'Hi' })
    expect(event.status).toBe(201)
    expect(event.durationMs).toBe(12)
    expect(event.surface).toBe('mcp')
  })

  test('should be an Event with a class-derived name and timestamp', () => {
    const event = new AgentToolInvoked(null, 'posts.index', {}, 200, 1, 'dev-mcp')

    expect(event).toBeInstanceOf(Event)
    expect(event.eventName).toBe('AgentToolInvoked')
    expect(AgentToolInvoked.eventName).toBe('AgentToolInvoked')
    expect(event.timestamp).toBeInstanceOf(Date)
  })

  test('should accept a null principal for an unauthenticated invocation', () => {
    expect(new AgentToolInvoked(null, 'posts.index', {}, 401, 1, 'cli').principal).toBeNull()
  })

  test('should carry a service principal', () => {
    const service: AgentPrincipal = { kind: 'service', id: 'token_1' }
    const event = new AgentToolInvoked(service, 'posts.index', {}, 200, 1, 'webmcp')

    expect(event.principal).toEqual(service)
    expect(event.surface).toBe('webmcp')
  })

  test('should expose arguments as an own property despite the reserved word', () => {
    const event = new AgentToolInvoked(principal, 'posts.store', { a: 1 }, 200, 1, 'mcp')

    expect(Object.prototype.hasOwnProperty.call(event, 'arguments')).toBe(true)
  })
})

describe('AgentToolDenied', () => {
  test('should carry the denial record', () => {
    const event = new AgentToolDenied(principal, 'posts.store', { title: 'Hi' }, 'scope', 'mcp')

    expect(event.principal).toEqual(principal)
    expect(event.tool).toBe('posts.store')
    expect(event.arguments).toEqual({ title: 'Hi' })
    expect(event.reason).toBe('scope')
    expect(event.surface).toBe('mcp')
  })

  test('should be an Event with a class-derived name', () => {
    const event = new AgentToolDenied(null, 'posts.store', {}, 'auth', 'mcp')

    expect(event).toBeInstanceOf(Event)
    expect(event.eventName).toBe('AgentToolDenied')
  })

  test('should carry each denial reason', () => {
    for (const reason of ['auth', 'scope', 'approval', 'rate-limit'] as const) {
      expect(new AgentToolDenied(null, 'posts.store', {}, reason, 'cli').reason).toBe(reason)
    }
  })
})
