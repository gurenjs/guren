import { describe, test, expect, beforeEach } from 'bun:test'
import {
  Gate,
  Response,
  setGate,
  getGate,
  can,
  cannot,
  authorize,
  Policy,
  definePolicy,
  authorizeMiddleware,
  authorizeAllMiddleware,
  authorizeResourceMiddleware,
} from '../../src/authorization'
import type { AuthorizeResourceOptions } from '../../src/authorization'
import { AuthorizationException } from '../../src/errors'
import type { Context } from '../../src/http/Application'
import type { Middleware } from '../../src/http/middleware'

class Post {
  constructor(
    public id: number,
    public authorId: number,
    public published: boolean = true
  ) {}
}

class Comment {
  constructor(
    public id: number,
    public userId: number,
    public postId: number
  ) {}
}

interface TestUser {
  id: number
  role: string
  name?: string
}

describe('Gate', () => {
  let gate: Gate

  beforeEach(() => {
    gate = new Gate()
  })

  describe('define', () => {
    test('defines a simple ability', () => {
      gate.define('admin', (user) => (user as TestUser | null)?.role === 'admin')
      expect(gate.has('admin')).toBe(true)
    })

    test('returns gate instance for chaining', () => {
      const result = gate.define('test', () => true)
      expect(result).toBe(gate)
    })
  })

  describe('allows', () => {
    test('checks ability with no arguments', async () => {
      gate.define('admin', (user) => (user as TestUser)?.role === 'admin')

      const adminGate = gate.forUser({ id: 1, role: 'admin' } as TestUser)
      const userGate = gate.forUser({ id: 2, role: 'user' } as TestUser)

      expect(await adminGate.allows('admin')).toBe(true)
      expect(await userGate.allows('admin')).toBe(false)
    })

    test('checks ability with model argument', async () => {
      gate.define('edit-post', (user, post: Post) => {
        return (user as TestUser)?.id === post.authorId
      })

      const post = new Post(1, 5)
      const authorGate = gate.forUser({ id: 5, role: 'user' } as TestUser)
      const otherGate = gate.forUser({ id: 10, role: 'user' } as TestUser)

      expect(await authorGate.allows('edit-post', post)).toBe(true)
      expect(await otherGate.allows('edit-post', post)).toBe(false)
    })

    test('returns false for undefined abilities', async () => {
      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)
      expect(await userGate.allows('nonexistent')).toBe(false)
    })

    test('handles null user', async () => {
      gate.define('guest-allowed', (user) => user === null)
      gate.define('user-required', (user) => user !== null)

      const guestGate = gate.forUser(null)

      expect(await guestGate.allows('guest-allowed')).toBe(true)
      expect(await guestGate.allows('user-required')).toBe(false)
    })

    test('handles async callbacks', async () => {
      gate.define('async-check', async (user) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return (user as TestUser)?.role === 'admin'
      })

      const adminGate = gate.forUser({ id: 1, role: 'admin' } as TestUser)
      expect(await adminGate.allows('async-check')).toBe(true)
    })
  })

  describe('denies', () => {
    test('returns opposite of allows', async () => {
      gate.define('admin', (user) => (user as TestUser)?.role === 'admin')

      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)

      expect(await userGate.denies('admin')).toBe(true)
      expect(await userGate.allows('admin')).toBe(false)
    })
  })

  describe('any', () => {
    test('returns true if any ability passes', async () => {
      gate.define('admin', (user) => (user as TestUser)?.role === 'admin')
      gate.define('moderator', (user) => (user as TestUser)?.role === 'moderator')
      gate.define('user', (user) => (user as TestUser)?.role === 'user')

      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)

      expect(await userGate.any(['admin', 'moderator', 'user'])).toBe(true)
      expect(await userGate.any(['admin', 'moderator'])).toBe(false)
    })
  })

  describe('all', () => {
    test('returns true only if all abilities pass', async () => {
      gate.define('verified', (user) => (user as TestUser)?.id !== undefined)
      gate.define('admin', (user) => (user as TestUser)?.role === 'admin')

      const adminGate = gate.forUser({ id: 1, role: 'admin' } as TestUser)
      const userGate = gate.forUser({ id: 2, role: 'user' } as TestUser)

      expect(await adminGate.all(['verified', 'admin'])).toBe(true)
      expect(await userGate.all(['verified', 'admin'])).toBe(false)
    })
  })

  describe('none', () => {
    test('returns true if no abilities pass', async () => {
      gate.define('admin', (user) => (user as TestUser)?.role === 'admin')
      gate.define('moderator', (user) => (user as TestUser)?.role === 'moderator')

      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)

      expect(await userGate.none(['admin', 'moderator'])).toBe(true)
    })
  })

  describe('authorize', () => {
    test('does not throw when authorized', async () => {
      gate.define('view', () => true)

      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)

      await expect(userGate.authorize('view')).resolves.toBeUndefined()
    })

    test('throws when not authorized', async () => {
      gate.define('admin', (user) => (user as TestUser)?.role === 'admin')

      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)

      await expect(userGate.authorize('admin')).rejects.toThrow('unauthorized')
    })
  })

  describe('before', () => {
    test('allows before callback to grant access', async () => {
      gate.before((user) => {
        if ((user as TestUser)?.role === 'admin') {
          return true
        }
        return undefined
      })

      gate.define('some-ability', () => false)

      const adminGate = gate.forUser({ id: 1, role: 'admin' } as TestUser)
      const userGate = gate.forUser({ id: 2, role: 'user' } as TestUser)

      expect(await adminGate.allows('some-ability')).toBe(true)
      expect(await userGate.allows('some-ability')).toBe(false)
    })

    test('allows before callback to deny access', async () => {
      gate.before((user) => {
        if ((user as TestUser)?.role === 'banned') {
          return false
        }
        return undefined
      })

      gate.define('view', () => true)

      const bannedGate = gate.forUser({ id: 1, role: 'banned' } as TestUser)
      const userGate = gate.forUser({ id: 2, role: 'user' } as TestUser)

      expect(await bannedGate.allows('view')).toBe(false)
      expect(await userGate.allows('view')).toBe(true)
    })
  })

  describe('after', () => {
    test('calls after callback with result', async () => {
      let afterCalled = false
      let afterResult: boolean | undefined

      gate.define('view', () => true)
      gate.after((user, ability, result) => {
        afterCalled = true
        afterResult = result
      })

      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)
      await userGate.allows('view')

      expect(afterCalled).toBe(true)
      expect(afterResult).toBe(true)
    })
  })

  describe('inspect', () => {
    test('returns authorization response', async () => {
      gate.define('view', () => true)
      gate.define('admin', () => false)

      const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)

      const allowed = await userGate.inspect('view')
      const denied = await userGate.inspect('admin')

      expect(allowed.allowed).toBe(true)
      expect(denied.allowed).toBe(false)
    })
  })

  describe('abilities', () => {
    test('returns list of defined abilities', () => {
      gate.define('view', () => true)
      gate.define('create', () => true)
      gate.define('delete', () => true)

      const abilities = gate.abilities()

      expect(abilities).toContain('view')
      expect(abilities).toContain('create')
      expect(abilities).toContain('delete')
      expect(abilities).toHaveLength(3)
    })
  })
})

describe('Policy', () => {
  let gate: Gate

  class PostPolicy extends Policy {
    before(user: TestUser | null, _ability: string) {
      if ((user as TestUser | null)?.role === 'admin') {
        return true
      }
      return undefined
    }

    viewAny(_user: TestUser | null) {
      return true
    }

    view(user: TestUser | null, post: Post) {
      return post.published || user?.id === post.authorId
    }

    create(user: TestUser | null) {
      return user !== null
    }

    update(user: TestUser | null, post: Post) {
      return user?.id === post.authorId
    }

    delete(user: TestUser | null, post: Post) {
      return user?.id === post.authorId
    }
  }

  beforeEach(() => {
    gate = new Gate()
    gate.policy(Post, PostPolicy)
  })

  test('checks policy methods', async () => {
    const post = new Post(1, 5, true)

    const authorGate = gate.forUser({ id: 5, role: 'user' } as TestUser)
    const otherGate = gate.forUser({ id: 10, role: 'user' } as TestUser)

    expect(await authorGate.allows('view', post)).toBe(true)
    expect(await authorGate.allows('update', post)).toBe(true)
    expect(await otherGate.allows('view', post)).toBe(true)
    expect(await otherGate.allows('update', post)).toBe(false)
  })

  test('policy before method grants admin access', async () => {
    const post = new Post(1, 999, true)

    const adminGate = gate.forUser({ id: 1, role: 'admin' } as TestUser)

    expect(await adminGate.allows('update', post)).toBe(true)
    expect(await adminGate.allows('delete', post)).toBe(true)
  })

  test('policy viewAny works without model', async () => {
    const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)
    expect(await userGate.allows('viewAny', new Post(0, 0))).toBe(true)
  })

  test('policy create checks user existence', async () => {
    const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)
    const guestGate = gate.forUser(null)

    const dummyPost = new Post(0, 0)
    expect(await userGate.allows('create', dummyPost)).toBe(true)
    expect(await guestGate.allows('create', dummyPost)).toBe(false)
  })

  test('resolves policy via [ModelClass, record] tuple for plain records', async () => {
    // ORM queries return plain objects with no constructor information
    const plainRecord = { id: 1, authorId: 5, published: true }

    const authorGate = gate.forUser({ id: 5, role: 'user' } as TestUser)
    const otherGate = gate.forUser({ id: 10, role: 'user' } as TestUser)

    expect(await authorGate.allows('update', [Post, plainRecord])).toBe(true)
    expect(await otherGate.allows('update', [Post, plainRecord])).toBe(false)
  })

  test('plain record without tuple cannot resolve a policy (denied)', async () => {
    const plainRecord = { id: 1, authorId: 5, published: true }
    const authorGate = gate.forUser({ id: 5, role: 'user' } as TestUser)

    expect(await authorGate.allows('update', plainRecord)).toBe(false)
  })

  test('resolves policy via bare model class for record-less abilities', async () => {
    const userGate = gate.forUser({ id: 1, role: 'user' } as TestUser)
    const guestGate = gate.forUser(null)

    expect(await userGate.allows('create', Post)).toBe(true)
    expect(await guestGate.allows('create', Post)).toBe(false)
  })

  test('resolves policy via [stringKey, record] tuple', async () => {
    gate.policy('post', PostPolicy)
    const plainRecord = { id: 1, authorId: 5, published: true }
    const authorGate = gate.forUser({ id: 5, role: 'user' } as TestUser)

    expect(await authorGate.allows('update', ['post', plainRecord])).toBe(true)
  })

  test('unpublished post only visible to author', async () => {
    const unpublishedPost = new Post(1, 5, false)

    const authorGate = gate.forUser({ id: 5, role: 'user' } as TestUser)
    const otherGate = gate.forUser({ id: 10, role: 'user' } as TestUser)

    expect(await authorGate.allows('view', unpublishedPost)).toBe(true)
    expect(await otherGate.allows('view', unpublishedPost)).toBe(false)
  })
})

describe('Policy returning an AuthorizationResponse', () => {
  class ResponsePolicy extends Policy {
    update(user: TestUser | null, post: Post) {
      return user?.id === post.authorId ? this.allow() : this.deny('You do not own this post.')
    }

    delete(user: TestUser | null, post: Post) {
      return user?.id === post.authorId ? true : this.denyAsNotFound()
    }

    publish(user: TestUser | null, _post: Post) {
      return user?.id === 1 ? true : this.denyWithStatus(402, 'Upgrade required.')
    }
  }

  const post = new Post(1, 1)
  let gate: Gate

  beforeEach(() => {
    gate = new Gate()
    gate.policy(Post, ResponsePolicy)
  })

  test('treats a denial response as denied, not allowed', async () => {
    const stranger = gate.forUser({ id: 2, role: 'user' } as TestUser)

    expect(await stranger.allows('update', post)).toBe(false)
    expect(await stranger.denies('update', post)).toBe(true)
    expect(await stranger.any(['update'], post)).toBe(false)
    expect(await stranger.all(['update'], post)).toBe(false)
  })

  test('treats an allow response as allowed', async () => {
    const owner = gate.forUser({ id: 1, role: 'user' } as TestUser)

    expect(await owner.allows('update', post)).toBe(true)
    expect(await owner.denies('update', post)).toBe(false)
  })

  test('authorize throws for a denial response and keeps the message', async () => {
    const stranger = gate.forUser({ id: 2, role: 'user' } as TestUser)

    await expect(stranger.authorize('update', post)).rejects.toThrow('You do not own this post.')
  })

  test('authorize does not throw for an allow response', async () => {
    const owner = gate.forUser({ id: 1, role: 'user' } as TestUser)

    await expect(owner.authorize('update', post)).resolves.toBeUndefined()
  })

  test('inspect reports the denial with its message', async () => {
    const stranger = gate.forUser({ id: 2, role: 'user' } as TestUser)
    const response = await stranger.inspect('update', post)

    expect(response.allowed).toBe(false)
    expect(response.message).toBe('You do not own this post.')
  })

  test('propagates the response status to the thrown exception', async () => {
    const stranger = gate.forUser({ id: 2, role: 'user' } as TestUser)

    const notFound = await stranger.authorize('delete', post).catch((error: unknown) => error)
    expect((notFound as { statusCode: number }).statusCode).toBe(404)

    const paymentRequired = await stranger.authorize('publish', post).catch((error: unknown) => error)
    expect((paymentRequired as { statusCode: number }).statusCode).toBe(402)
    expect((paymentRequired as Error).message).toBe('Upgrade required.')
  })

  // A non-boolean `before` result must short-circuit: a denial object that falls through
  // is then allowed by a permissive ability method.
  test('honours a denial response from a gate before callback', async () => {
    gate.before(() => Response.deny('banned'))
    gate.define('view', () => true)

    const userGate = gate.forUser({ id: 2, role: 'user' } as TestUser)

    expect(await userGate.allows('view')).toBe(false)
    expect((await userGate.inspect('view')).message).toBe('banned')
  })

  test('honours a denial response from a policy before method', async () => {
    class BeforePolicy extends Policy {
      before() {
        return this.deny('suspended')
      }

      update() {
        return true
      }
    }

    const policyGate = new Gate()
    policyGate.policy(Post, BeforePolicy)

    expect(await policyGate.forUser({ id: 1, role: 'user' } as TestUser).allows('update', post)).toBe(false)
  })

  test('still continues to the ability method when before returns undefined', async () => {
    gate.before(() => undefined)
    gate.define('view', () => true)

    expect(await gate.forUser({ id: 2, role: 'user' } as TestUser).allows('view')).toBe(true)
  })

  test('reports the denial to after callbacks as a boolean', async () => {
    const seen: unknown[] = []
    gate.after((_user, _ability, result) => {
      seen.push(result)
    })

    await gate.forUser({ id: 2, role: 'user' } as TestUser).allows('update', post)

    expect(seen).toEqual([false])
  })
})

describe('definePolicy', () => {
  test('creates policy from definition object', async () => {
    const CommentPolicy = definePolicy<Comment>({
      view: () => true,
      create: (user): boolean => user !== null,
      update: (user, comment) => (user as TestUser)?.id === comment.userId,
      delete: (user, comment) => (user as TestUser)?.id === comment.userId,
    })

    const gate = new Gate()
    gate.policy(Comment, CommentPolicy)

    const comment = new Comment(1, 5, 1)
    const ownerGate = gate.forUser({ id: 5, role: 'user' } as TestUser)
    const otherGate = gate.forUser({ id: 10, role: 'user' } as TestUser)

    expect(await ownerGate.allows('view', comment)).toBe(true)
    expect(await ownerGate.allows('update', comment)).toBe(true)
    expect(await otherGate.allows('update', comment)).toBe(false)
  })

  test('supports before callback', async () => {
    const AdminPolicy = definePolicy({
      before: (user, _ability) => {
        if ((user as TestUser)?.role === 'superadmin') return true
        return undefined
      },
      update: () => false,
    })

    class Admin {
      constructor(public id: number) {}
    }

    const gate = new Gate()
    gate.policy(Admin, AdminPolicy)

    const admin = new Admin(1)
    const superGate = gate.forUser({ id: 1, role: 'superadmin' } as TestUser)
    const userGate = gate.forUser({ id: 2, role: 'user' } as TestUser)

    expect(await superGate.allows('update', admin)).toBe(true)
    expect(await userGate.allows('update', admin)).toBe(false)
  })
})

describe('Response', () => {
  test('allow creates allowed response', () => {
    const response = Response.allow('Allowed!')
    expect(response.allowed).toBe(true)
    expect(response.message).toBe('Allowed!')
  })

  test('deny creates denied response', () => {
    const response = Response.deny('Not allowed', 'FORBIDDEN')
    expect(response.allowed).toBe(false)
    expect(response.message).toBe('Not allowed')
    expect(response.code).toBe('FORBIDDEN')
  })

  test('denyWithStatus includes status code', () => {
    const response = Response.denyWithStatus(403, 'Forbidden')
    expect(response.allowed).toBe(false)
    expect(response.status).toBe(403)
  })

  test('denyAsNotFound sets 404 status', () => {
    const response = Response.denyAsNotFound()
    expect(response.allowed).toBe(false)
    expect(response.status).toBe(404)
  })
})

describe('Global Gate', () => {
  beforeEach(() => {
    const gate = new Gate()
    gate.define('test-ability', () => true)
    setGate(gate)
  })

  test('getGate returns global gate', () => {
    const gate = getGate()
    expect(gate).toBeInstanceOf(Gate)
    expect(gate.has('test-ability')).toBe(true)
  })

  test('can checks ability on global gate', async () => {
    expect(await can('test-ability')).toBe(true)
  })

  test('cannot checks denial on global gate', async () => {
    const gate = new Gate()
    gate.define('admin', () => false)
    setGate(gate)

    expect(await cannot('admin')).toBe(true)
  })

  test('authorize throws on denial', async () => {
    const gate = new Gate()
    gate.define('denied', () => false)
    setGate(gate)

    await expect(authorize('denied')).rejects.toThrow()
  })
})

describe('Authorization Integration', () => {
  test('complex authorization scenario', async () => {
    const gate = new Gate()

    gate.before((user) => {
      if ((user as TestUser)?.role === 'superadmin') {
        return true
      }
      return undefined
    })

    gate.define('access-dashboard', (user) => {
      const u = user as TestUser
      return ['admin', 'moderator'].includes(u?.role ?? '')
    })

    gate.define('manage-users', (user) => {
      return (user as TestUser)?.role === 'admin'
    })

    class TestPostPolicy extends Policy {
      view(user: TestUser | null, post: Post) {
        return post.published || user?.id === post.authorId
      }

      update(user: TestUser | null, post: Post) {
        if ((user as TestUser | null)?.role === 'admin') return true
        return user?.id === post.authorId
      }
    }

    gate.policy(Post, TestPostPolicy)

    const superadmin = gate.forUser({ id: 1, role: 'superadmin' } as TestUser)
    const admin = gate.forUser({ id: 2, role: 'admin' } as TestUser)
    const moderator = gate.forUser({ id: 3, role: 'moderator' } as TestUser)
    const user = gate.forUser({ id: 4, role: 'user' } as TestUser)

    const post = new Post(1, 4, false) // Unpublished, owned by user id 4

    expect(await superadmin.allows('access-dashboard')).toBe(true)
    expect(await superadmin.allows('manage-users')).toBe(true)
    expect(await superadmin.allows('update', post)).toBe(true)

    expect(await admin.allows('access-dashboard')).toBe(true)
    expect(await admin.allows('manage-users')).toBe(true)
    expect(await admin.allows('update', post)).toBe(true)

    expect(await moderator.allows('access-dashboard')).toBe(true)
    expect(await moderator.allows('manage-users')).toBe(false)
    expect(await moderator.allows('update', post)).toBe(false)

    expect(await user.allows('access-dashboard')).toBe(false)
    expect(await user.allows('manage-users')).toBe(false)
    expect(await user.allows('update', post)).toBe(true)
    expect(await user.allows('view', post)).toBe(true)
  })
})

const drive = async (middleware: Middleware, method = 'GET') => {
  const ctx = { req: { method }, get: () => ({ id: 1 }) } as unknown as Context
  let nextCalled = false
  await middleware(ctx, async () => {
    nextCalled = true
  })
  return nextCalled
}

describe('authorizeResourceMiddleware', () => {
  let checkedAbilities: string[]

  beforeEach(() => {
    checkedAbilities = []
    const gate = new Gate()
    for (const ability of ['view', 'create', 'update', 'delete', 'purge']) {
      gate.define(ability, () => {
        checkedAbilities.push(ability)
        return true
      })
    }
    setGate(gate)
  })

  const run = (method: string, options?: AuthorizeResourceOptions) =>
    drive(authorizeResourceMiddleware(() => ({ id: 1 }), options), method)

  test('maps known methods to resource abilities', async () => {
    const expected: Array<[string, string]> = [
      ['GET', 'view'],
      ['HEAD', 'view'],
      ['QUERY', 'view'],
      ['POST', 'create'],
      ['PUT', 'update'],
      ['PATCH', 'update'],
      ['DELETE', 'delete'],
    ]
    for (const [method, ability] of expected) {
      checkedAbilities = []
      expect(await run(method)).toBe(true)
      expect(checkedAbilities).toEqual([ability])
    }
  })

  test('denies unknown methods without consulting the gate', async () => {
    await expect(run('PURGE')).rejects.toThrow(AuthorizationException)
    expect(checkedAbilities).toEqual([])
  })

  test('uses options.message when denying an unknown method', async () => {
    await expect(run('PURGE', { message: 'Custom denial' })).rejects.toThrow('Custom denial')
  })

  test('abilityFor maps a custom method to an ability', async () => {
    const abilityFor = (method: string) => (method === 'PURGE' ? 'purge' : undefined)
    expect(await run('PURGE', { abilityFor })).toBe(true)
    expect(checkedAbilities).toEqual(['purge'])
  })

  test('abilityFor returning undefined falls back to the default mapping', async () => {
    const abilityFor = () => undefined
    expect(await run('DELETE', { abilityFor })).toBe(true)
    expect(checkedAbilities).toEqual(['delete'])
    checkedAbilities = []
    await expect(run('PURGE', { abilityFor })).rejects.toThrow(AuthorizationException)
    expect(checkedAbilities).toEqual([])
  })

  test('abilityFor can override a built-in mapping', async () => {
    const abilityFor = (method: string) => (method === 'POST' ? 'update' : undefined)
    expect(await run('POST', { abilityFor })).toBe(true)
    expect(checkedAbilities).toEqual(['update'])
  })

  test('captures abilityFor at creation, so a later assignment cannot apply', async () => {
    // The capability stamp fixes `fromMethodMap` at creation; re-reading options per
    // request would let a later assignment change the ability checked.
    const options: AuthorizeResourceOptions = {}
    const middleware = authorizeResourceMiddleware(() => ({ id: 1 }), options)
    options.abilityFor = () => 'purge'

    expect(await drive(middleware, 'DELETE')).toBe(true)
    expect(checkedAbilities).toEqual(['delete'])
  })
})

describe('authorize middleware ability snapshots', () => {
  let checkedAbilities: string[]

  beforeEach(() => {
    checkedAbilities = []
    const gate = new Gate()
    for (const ability of ['admin', 'moderator', 'billing']) {
      gate.define(ability, () => {
        checkedAbilities.push(ability)
        return true
      })
    }
    setGate(gate)
  })

  test('authorizeMiddleware checks the array as it was at creation', async () => {
    const abilities = ['admin', 'moderator']
    const middleware = authorizeMiddleware(abilities)
    abilities.length = 0

    expect(await drive(middleware)).toBe(true)
    // Not [] — an emptied array would make Gate.any([]) deny everything.
    expect(checkedAbilities).toEqual(['admin'])
  })

  test('authorizeAllMiddleware checks the array as it was at creation', async () => {
    const abilities = ['admin', 'billing']
    const middleware = authorizeAllMiddleware(abilities)
    abilities.length = 0

    expect(await drive(middleware)).toBe(true)
    // Not [] — Gate.all([]) is vacuously true and would authorize anyone.
    expect(checkedAbilities).toEqual(['admin', 'billing'])
  })

  test('a one-element array keeps the policy denial, like the bare ability', async () => {
    const gate = new Gate()
    gate.define('publish', () => Response.denyWithStatus(404, 'No such post.'))
    setGate(gate)

    // Any-of over one ability is that ability, so its own denial response must survive.
    await expect(drive(authorizeMiddleware(['publish']))).rejects.toThrow('No such post.')
    await expect(drive(authorizeMiddleware('publish'))).rejects.toThrow('No such post.')

    // Two alternatives have no single response to carry, so that denial stays generic.
    await expect(drive(authorizeMiddleware(['publish', 'admin']))).rejects.toThrow(
      'This action is unauthorized.'
    )
  })

  test('an empty ability list still denies every request', async () => {
    await expect(drive(authorizeMiddleware([]))).rejects.toThrow(AuthorizationException)
  })

  test('authorizeAllMiddleware refuses an empty ability list at creation', () => {
    expect(() => authorizeAllMiddleware([])).toThrow('at least one ability')
  })
})
