import { describe, expect, test } from 'bun:test'

import {
  compareRecords,
  compareSecurityRecords,
  schemaOnlyTightens,
  SECURITY_RECORD_VERSION,
  type ActionRecord,
  type AuthorizationCall,
  type MiddlewareRecord,
  type RouteSecurityRecord,
  type ValidateCall,
} from '../src/change/security-records'

const auth: MiddlewareRecord = { kind: 'alias', name: 'auth', capabilities: { authentication: { mode: 'required' } } }
const guest: MiddlewareRecord = { kind: 'inline', name: null, capabilities: { authentication: { mode: 'guest-only' } } }
const throttle: MiddlewareRecord = { kind: 'inline', name: null, capabilities: {} }
const can = (abilities: string[], mode: 'all' | 'any' | 'mixed' = 'all'): MiddlewareRecord => ({ kind: 'inline', name: null, capabilities: { authorization: { abilities, mode } } })
const schema = { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'] }
const POST_SCHEMA = 'app/Http/Validators/PostValidator.ts#PostSchema'
const body = (value: unknown = schema, exports = [POST_SCHEMA], declarations: Record<string, string> = { [POST_SCHEMA]: 'declaration:a' }) => ({ body: { schema: value, exports, declarations } })

const authorize = (ability: string, subject = '[Post, post]', member: AuthorizationCall['member'] = 'authorize'): AuthorizationCall => ({ member, ability, subject })
const validate = (name: string, member = 'validateParams', declaration = 'declaration:id'): ValidateCall => ({ member, schema: `app/Http/Validators/PostValidator.ts#${name}`, declaration })

const handler = (overrides: Partial<Extract<ActionRecord, { authorizes: unknown }>> = {}): ActionRecord => ({
  authenticates: false, authorizes: [authorize('update')], validates: [validate('PostIdSchema')], ...overrides,
})

function route(overrides: Partial<RouteSecurityRecord> = {}): RouteSecurityRecord {
  return {
    method: 'PUT',
    path: '/posts/:id',
    name: 'posts.update',
    module: null,
    action: 'PostController.update',
    middleware: [auth],
    contracts: body(),
    handler: handler(),
    ...overrides,
  }
}

const verdict = (base: RouteSecurityRecord, head: RouteSecurityRecord) => compareRecords(base, head).verdict

describe('compareRecords', () => {
  test('is same for equal records, whatever the path or name', () => {
    expect(verdict(route(), route({ path: '/articles/:id', name: 'articles.update' }))).toBe('same')
  })

  test('is weaker for an authentication or authorization guard, an authorize() call, a contract or a validator gone', () => {
    expect(compareRecords(route(), route({ middleware: [] }))).toMatchObject({ verdict: 'weaker', authorization: [expect.stringContaining('authentication required')] })
    expect(compareRecords(route({ middleware: [auth, can(['update'])] }), route())).toMatchObject({ verdict: 'weaker', authorization: [expect.stringContaining('authorization all update')] })
    expect(compareRecords(route(), route({ handler: handler({ authorizes: [] }) }))).toMatchObject({ verdict: 'weaker', authorization: ["this.authorize('update') is no longer called"] })
    expect(compareRecords(route(), route({ contracts: {} }))).toMatchObject({ verdict: 'weaker', validation: ['the body contract is gone'] })
    expect(compareRecords(route(), route({ handler: handler({ validates: [] }) }))).toMatchObject({ verdict: 'weaker', validation: [expect.stringContaining('validateParams(app/Http/Validators/PostValidator.ts#PostIdSchema)')] })
    expect(compareRecords(route({ middleware: [], handler: handler({ authenticates: true }) }), route({ middleware: [] }))).toMatchObject({ verdict: 'weaker', authorization: [expect.stringContaining('no longer refuses a guest')] })
  })

  test('is weaker for an ability dropped from an all list or added to an any list', () => {
    expect(verdict(route({ middleware: [can(['update', 'publish'])] }), route({ middleware: [can(['update'])] }))).toBe('weaker')
    expect(verdict(route({ middleware: [can(['update', 'publish'], 'any')] }), route({ middleware: [can(['update', 'publish', 'view'], 'any')] }))).toBe('weaker')
  })

  test('matches the chain one to one, so a duplicate guard dropped, or authentication lost beside a kept ability, is weaker', () => {
    const grouped = (capabilities: MiddlewareRecord['capabilities']): MiddlewareRecord => ({ kind: 'inline', name: null, capabilities })
    expect(verdict(route({ middleware: [can(['update']), can(['update'])] }), route({ middleware: [can(['update'])] }))).toBe('weaker')
    const both = grouped({ authentication: { mode: 'required' }, authorization: { abilities: ['admin'], mode: 'all' } })
    expect(verdict(route({ middleware: [both] }), route({ middleware: [grouped({ authorization: { abilities: ['admin'], mode: 'all' } })] }))).toBe('weaker')
  })

  test('is incomparable for a group whose members, or a kept entry, run in another order', () => {
    const group = (members: string[]): MiddlewareRecord => ({ kind: 'group', name: 'web', capabilities: { authentication: { mode: 'required' } }, members })
    expect(verdict(route({ middleware: [group(['auth', 'throttle'])] }), route({ middleware: [group(['throttle', 'auth'])] }))).toBe('incomparable')
    expect(verdict(route({ middleware: [can(['update']), throttle] }), route({ middleware: [throttle, can(['update', 'publish'])] }))).toBe('incomparable')
  })

  test('compares an action it could not read by the digest of what declares its class', () => {
    expect(verdict(route({ handler: { unread: 'not found', digest: 'a' } }), route({ handler: { unread: 'not found', digest: 'a' } }))).toBe('same')
    expect(verdict(route({ handler: { unread: 'not found', digest: 'a' } }), route({ handler: { unread: 'not found', digest: 'b' } }))).toBe('incomparable')
  })

  test('is incomparable for a group that lost a member or names one nothing registers', () => {
    const group = (members: string[], extra: Partial<MiddlewareRecord> = {}): MiddlewareRecord => ({ kind: 'group', name: 'admin', capabilities: { authentication: { mode: 'required' } }, members, ...extra })
    expect(verdict(route({ middleware: [group(['auth', 'role'])] }), route({ middleware: [group(['auth'])] }))).toBe('incomparable')
    expect(verdict(route({ middleware: [group(['auth'])] }), route({ middleware: [group(['auth', 'role'])] }))).toBe('stronger')
    expect(verdict(route({ middleware: [group(['auth'])] }), route({ middleware: [group(['auth', 'role'], { unresolvedMembers: ['role'] })] }))).toBe('incomparable')
  })

  test('is incomparable for a mixed chain, a request-time ability, an unregistered middleware, a reorder, another ability or subject, a replaced validator or a narrowed schema', () => {
    const incomparable = (base: RouteSecurityRecord, head: RouteSecurityRecord) => expect(verdict(base, head)).toBe('incomparable')
    incomparable(route({ middleware: [auth, can(['update', 'publish'], 'mixed')] }), route({ middleware: [auth] }))
    incomparable(route({ middleware: [auth, { kind: 'inline', name: null, capabilities: { authorization: { abilities: [], mode: 'all', resource: { fromMethodMap: false } } } }] }), route())
    incomparable(route({ middleware: [auth, { kind: 'alias', name: 'admin', capabilities: {}, unresolved: true }] }), route({ middleware: [auth] }))
    incomparable(route({ middleware: [auth, throttle] }), route({ middleware: [throttle, auth] }))
    incomparable(route(), route({ handler: handler({ authorizes: [authorize('view')] }) }))
    incomparable(route(), route({ handler: handler({ authorizes: [authorize('update', '[Comment, comment]')] }) }))
    incomparable(route(), route({ handler: handler({ validates: [validate('OtherSchema')] }) }))
    incomparable(route(), route({ handler: handler({ validates: [validate('PostIdSchema', 'validateParamsSafe')] }) }))
    incomparable(route(), route({ handler: handler({ validates: [validate('PostIdSchema', 'validateParams', 'declaration:looser')] }) }))
    incomparable(route(), route({ contracts: body(schema, ['app/Http/Validators/PostValidator.ts#OtherSchema']) }))
    incomparable(route(), route({ contracts: body({ ...schema, required: [] }) }))
    incomparable(route({ middleware: [auth, throttle] }), route({ middleware: [auth] }))
    incomparable(route(), route({ handler: handler({ unseen: 'digest' }) }))
    incomparable(route({ handler: handler({ unseen: 'one' }) }), route({ handler: handler({ unseen: 'two' }) }))
    incomparable(route(), route({ handler: { unread: 'an inline handler' } }))
  })

  test('compares an unrendered schema by its declaration', () => {
    const unread = { unreadable: 'z.custom()' }
    expect(verdict(route({ contracts: body(unread) }), route({ contracts: body(unread) }))).toBe('same')
    expect(verdict(route({ contracts: body(unread) }), route({ contracts: body(unread, [POST_SCHEMA], { [POST_SCHEMA]: 'declaration:b' }) }))).toBe('incomparable')
  })

  test('is stronger for a guard, an ability in an all list, an authorize() call, a validator or a tightened schema added', () => {
    expect(verdict(route({ middleware: [] }), route())).toBe('stronger')
    expect(verdict(route({ middleware: [can(['update'])] }), route({ middleware: [can(['update', 'publish'])] }))).toBe('stronger')
    expect(verdict(route(), route({ handler: handler({ authorizes: [authorize('update'), authorize('publish', '', 'can')] }) }))).toBe('stronger')
    expect(verdict(route(), route({ handler: handler({ validates: [validate('PostIdSchema'), validate('QuerySchema', 'validateQuery')] }) }))).toBe('stronger')
    const tighter = { ...schema, properties: { title: { type: 'string', minLength: 3, maxLength: 80 }, body: { type: 'string' } }, required: ['title', 'body'] }
    expect(verdict(route(), route({ contracts: body(tighter) }))).toBe('stronger')
  })

  test('gives no fact for a requireGuest removed, nor for userOrFail() moved onto the chain', () => {
    expect(verdict(route({ middleware: [guest] }), route({ middleware: [] }))).toBe('same')
    expect(verdict(route({ middleware: [], handler: handler({ authenticates: true }) }), route({ middleware: [auth] }))).toBe('stronger')
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

  test('matches a moved route by its action, so a move reads as the same record and a changed route', () => {
    const moved = route({ path: '/articles/:id' })
    expect(compareSecurityRecords(records(route()), records(moved))).toEqual({ facts: [], incomparable: [], added: [], removed: [], changed: [{ base: route(), head: moved }] })
  })

  test('compares an added route to an action with each of its base routes, so a second path with fewer guards is weaker', () => {
    const second = route({ method: 'PATCH', middleware: [] })
    const { facts } = compareSecurityRecords(records(route()), records(route(), second))
    expect(facts).toEqual([expect.objectContaining({ code: 'authorization-removed', lane: 'high', message: expect.stringContaining('PATCH /posts/:id (against PUT /posts/:id)') })])
  })

  test('falls back to the method and path, then across modules, and holds a match it cannot make one to one', () => {
    expect(compareSecurityRecords(records(route({ action: 'Old.update' })), records(route({ action: 'New.update', middleware: [] }))).facts).toHaveLength(1)
    expect(compareSecurityRecords(records(route({ module: 'billing' })), records(route({ middleware: [] }))).facts).toHaveLength(1)
    const twice = records(route({ action: 'A.update' }), route({ action: 'B.update' }))
    expect(compareSecurityRecords(twice, records(route({ action: 'C.update' }))).incomparable).toEqual([expect.stringContaining('2 base routes share its method and path')])
  })

  test('holds a head route with no counterpart while a base route of its method and action name left', () => {
    const renamed = route({ action: 'ArticleController.update', path: '/articles/:id', middleware: [] })
    expect(compareSecurityRecords(records(route()), records(renamed)).incomparable).toEqual([expect.stringContaining('a rename and a move the reader cannot pair')])
  })

  test('lists an added route that pairs with nothing that left, and a base route no head route matched', () => {
    const health = route({ method: 'GET', path: '/health', action: undefined, middleware: [] })
    expect(compareSecurityRecords(records(route()), records(route(), health))).toEqual({ facts: [], incomparable: [], added: [health], removed: [], changed: [] })
    expect(compareSecurityRecords(records(route(), health), records(route()))).toEqual({ facts: [], incomparable: [], added: [], removed: [health], changed: [] })
  })

  test('reads a gained agent tool as a changed record, which the security verdict leaves the same', () => {
    const tool = route({ agent: { toolName: 'posts_update' } })
    expect(compareSecurityRecords(records(route()), records(tool))).toEqual({ facts: [], incomparable: [], added: [], removed: [], changed: [{ base: route(), head: tool }] })
  })
})
