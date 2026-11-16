import { describe, expect, test } from 'bun:test'

import { compareRecords, compareSecurityRecords, schemaOnlyTightens, SECURITY_RECORD_VERSION, type MiddlewareRecord, type RouteSecurityRecord } from '../src/change/security-records'

const auth: MiddlewareRecord = { kind: 'alias', name: 'auth', capabilities: { authentication: { mode: 'required' } } }
const guest: MiddlewareRecord = { kind: 'inline', name: null, capabilities: { authentication: { mode: 'guest-only' } } }
const throttle: MiddlewareRecord = { kind: 'inline', name: null, capabilities: {} }
const can = (abilities: string[], mode: 'all' | 'any' | 'mixed' = 'all'): MiddlewareRecord => ({ kind: 'inline', name: null, capabilities: { authorization: { abilities, mode } } })
const schema = { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'] }

function route(overrides: Partial<RouteSecurityRecord> = {}): RouteSecurityRecord {
  return {
    method: 'PUT',
    path: '/posts/:id',
    name: 'posts.update',
    module: null,
    action: 'PostController.update',
    middleware: [auth],
    contracts: { body: { schema, exports: ['app/Http/Validators/PostValidator.ts#PostSchema'] } },
    handler: { authenticates: false, authorizes: [{ member: 'authorize', ability: 'update' }], validates: ['PostIdSchema'] },
    ...overrides,
  }
}

const handler = (overrides: Partial<Extract<RouteSecurityRecord['handler'], { authorizes: unknown }>>): RouteSecurityRecord['handler'] => ({
  authenticates: false, authorizes: [{ member: 'authorize', ability: 'update' }], validates: ['PostIdSchema'], ...overrides,
})

describe('compareRecords', () => {
  test('is same for equal records, whatever the path or name', () => {
    expect(compareRecords(route(), route({ path: '/articles/:id', name: 'articles.update' })).verdict).toBe('same')
  })

  test('is weaker for an authentication or authorization guard, an authorize() call, a contract or a validator gone', () => {
    expect(compareRecords(route(), route({ middleware: [] }))).toMatchObject({ verdict: 'weaker', authorization: [expect.stringContaining('authentication required')] })
    expect(compareRecords(route({ middleware: [auth, can(['update'])] }), route())).toMatchObject({ verdict: 'weaker', authorization: [expect.stringContaining('authorization all update')] })
    expect(compareRecords(route(), route({ handler: handler({ authorizes: [] }) }))).toMatchObject({ verdict: 'weaker', authorization: ["this.authorize('update') is no longer called"] })
    expect(compareRecords(route(), route({ contracts: {} }))).toMatchObject({ verdict: 'weaker', validation: ['the body contract is gone'] })
    expect(compareRecords(route(), route({ handler: handler({ validates: [] }) }))).toMatchObject({ verdict: 'weaker', validation: ['the action no longer validates with PostIdSchema'] })
    expect(compareRecords(route({ middleware: [], handler: handler({ authenticates: true }) }), route({ middleware: [] }))).toMatchObject({ verdict: 'weaker', authorization: [expect.stringContaining('no longer refuses a guest')] })
  })

  test('is weaker for an ability dropped from an all list or added to an any list', () => {
    expect(compareRecords(route({ middleware: [can(['update', 'publish'])] }), route({ middleware: [can(['update'])] })).verdict).toBe('weaker')
    expect(compareRecords(route({ middleware: [can(['update', 'publish'], 'any')] }), route({ middleware: [can(['update', 'publish', 'view'], 'any')] })).verdict).toBe('weaker')
  })

  test('is incomparable for a mixed chain, a request-time ability, an unregistered middleware, a reorder, another ability, a replaced validator or a narrowed schema', () => {
    const incomparable = (base: RouteSecurityRecord, head: RouteSecurityRecord) => expect(compareRecords(base, head).verdict).toBe('incomparable')
    incomparable(route({ middleware: [auth, can(['update', 'publish'], 'mixed')] }), route({ middleware: [auth] }))
    incomparable(route({ middleware: [auth, { kind: 'inline', name: null, capabilities: { authorization: { abilities: [], mode: 'all', resource: { fromMethodMap: false } } } }] }), route())
    incomparable(route({ middleware: [auth, { kind: 'alias', name: 'admin', capabilities: {}, unresolved: true }] }), route({ middleware: [auth] }))
    incomparable(route({ middleware: [auth, throttle] }), route({ middleware: [throttle, auth] }))
    incomparable(route(), route({ handler: handler({ authorizes: [{ member: 'authorize', ability: 'view' }] }) }))
    incomparable(route(), route({ handler: handler({ validates: ['OtherSchema'] }) }))
    incomparable(route(), route({ contracts: { body: { schema, exports: ['app/Http/Validators/PostValidator.ts#OtherSchema'] } } }))
    incomparable(route(), route({ contracts: { body: { schema: { ...schema, required: [] }, exports: ['app/Http/Validators/PostValidator.ts#PostSchema'] } } }))
    incomparable(route({ middleware: [auth, throttle] }), route({ middleware: [auth] }))
    incomparable(route(), route({ handler: handler({ dynamicAuthorization: true }) }))
    incomparable(route(), route({ handler: { unread: 'an inline handler' } }))
  })

  test('is stronger for a guard, an ability in an all list, an authorize() call, a validator or a tightened schema added', () => {
    expect(compareRecords(route({ middleware: [] }), route()).verdict).toBe('stronger')
    expect(compareRecords(route({ middleware: [can(['update'])] }), route({ middleware: [can(['update', 'publish'])] })).verdict).toBe('stronger')
    expect(compareRecords(route(), route({ handler: handler({ authorizes: [{ member: 'authorize', ability: 'update' }, { member: 'can', ability: 'publish' }] }) })).verdict).toBe('stronger')
    expect(compareRecords(route(), route({ handler: handler({ validates: ['PostIdSchema', 'QuerySchema'] }) })).verdict).toBe('stronger')
    const tighter = { ...schema, properties: { title: { type: 'string', minLength: 3, maxLength: 80 }, body: { type: 'string' } }, required: ['title', 'body'] }
    expect(compareRecords(route(), route({ contracts: { body: { schema: tighter, exports: ['app/Http/Validators/PostValidator.ts#PostSchema'] } } })).verdict).toBe('stronger')
  })

  test('gives no fact for a requireGuest removed, nor for userOrFail() moved onto the chain', () => {
    expect(compareRecords(route({ middleware: [guest] }), route({ middleware: [] })).verdict).toBe('same')
    expect(compareRecords(route({ middleware: [], handler: handler({ authenticates: true }) }), route({ middleware: [auth] })).verdict).toBe('stronger')
  })
})

describe('schemaOnlyTightens', () => {
  test('accepts gained properties, required keys and bounds, and refuses anything else', () => {
    expect(schemaOnlyTightens(schema, { ...schema, required: ['title', 'body'], properties: { ...schema.properties, body: { type: 'string' } } })).toBe(true)
    expect(schemaOnlyTightens({ type: 'string', maxLength: 10 }, { type: 'string', maxLength: 5 })).toBe(true)
    expect(schemaOnlyTightens({ type: 'string', maxLength: 5 }, { type: 'string', maxLength: 10 })).toBe(false)
    expect(schemaOnlyTightens({ type: 'string', minLength: 1 }, { type: 'string' })).toBe(false)
    expect(schemaOnlyTightens(schema, { ...schema, properties: {} })).toBe(false)
    expect(schemaOnlyTightens({ type: 'string' }, { type: 'number' })).toBe(false)
    expect(schemaOnlyTightens({ type: 'string' }, { type: 'string', description: 'x' })).toBe(false)
  })
})

describe('compareSecurityRecords', () => {
  const records = (...routes: RouteSecurityRecord[]) => ({ recordVersion: SECURITY_RECORD_VERSION, routes })

  test('matches a moved route by its action, so a move reads as the same record', () => {
    expect(compareSecurityRecords(records(route()), records(route({ path: '/articles/:id' })))).toEqual({ facts: [], incomparable: [] })
  })

  test('compares an added route to an action with each of its base routes, so a second path with fewer guards is weaker', () => {
    const second = route({ method: 'PATCH', middleware: [] })
    const { facts } = compareSecurityRecords(records(route()), records(route(), second))
    expect(facts).toEqual([expect.objectContaining({ code: 'authorization-removed', lane: 'high', message: expect.stringContaining('PATCH /posts/:id (against PUT /posts/:id)') })])
  })

  test('falls back to the method and path, and holds a match it cannot make one to one', () => {
    expect(compareSecurityRecords(records(route({ action: 'Old.update' })), records(route({ action: 'New.update', middleware: [] }))).facts).toHaveLength(1)
    const twice = records(route({ action: 'A.update' }), route({ action: 'B.update' }))
    expect(compareSecurityRecords(twice, records(route({ action: 'C.update' }))).incomparable).toEqual([expect.stringContaining('2 base routes share its method and path')])
  })

  test('matches within a module, and says nothing of an added route with no counterpart', () => {
    expect(compareSecurityRecords(records(route({ module: 'billing' })), records(route({ middleware: [] })))).toEqual({ facts: [], incomparable: [] })
  })
})
