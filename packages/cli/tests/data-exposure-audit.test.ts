import { describe, expect, it } from 'bun:test'
import type { AppManifest } from '@guren/server'
import type { AuditFinding, AuditedRoute } from '../src/audit'
import { auditDataExposure, isSensitiveColumn } from '../src/data-exposure-audit'
import { ParseCache } from '../src/parse-cache'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const SCHEMA = `import { pgTable, serial, text } from 'drizzle-orm/pg-core'
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  apiKey: text('api_key'),
})
`

const USER_MODEL = `import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  hidden: ['passwordHash', 'rememberToken'],
}) {}
`

function controller(body: string): string {
  return `import { Controller } from '@guren/core'
import { User } from '../../Models/User'

export default class UserController extends Controller {
${body}
}
`
}

function manifest(auth: unknown): AppManifest {
  return { providers: [], warnings: [], bindings: [], auth } as unknown as AppManifest
}

const MODEL_PROVIDER = { guards: ['web'], defaultGuard: 'web', providers: { users: { kind: 'model', model: 'User', hasher: null, algorithm: null, requiresBun: null } } }

async function audit(files: Record<string, string>, options: { routes?: AuditedRoute[]; manifest?: AppManifest } = {}) {
  const workspace = await createTempWorkspace('guren-cli-data-exposure-')
  try {
    await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': SCHEMA, 'app/Models/User.ts': USER_MODEL, ...files })
    const findings: AuditFinding[] = []
    const report = await auditDataExposure({ cwd: workspace.dir, routes: options.routes ?? [], cache: new ParseCache(), findings, ...(options.manifest ? { manifest: options.manifest } : {}) })
    return { findings, report }
  } finally {
    await workspace.cleanup()
  }
}

const keys = (findings: AuditFinding[]) => findings.map((finding) => finding.key)

describe('isSensitiveColumn', () => {
  it('matches whole camelCase and snake_case segments', () => {
    for (const name of ['passwordHash', 'password_hash', 'rememberToken', 'apiKey', 'api_key', 'otpSecret', 'otp', 'resetTokenHash']) expect(isSensitiveColumn(name)).toBe(true)
    for (const name of ['email', 'hashtag', 'tokenizer', 'keyboard', 'notes', 'emailVerifiedAt']) expect(isSensitiveColumn(name)).toBe(false)
  })
})

describe('auditDataExposure', () => {
  it('reports every sensitive column of a whole record sent to a page, hidden ones included', async () => {
    const { findings } = await audit({
      'app/Http/Controllers/UserController.ts': controller(`  async show() {
    const user = await User.findOrFail(1)
    return this.inertia('users/Show', { user })
  }`),
    })

    expect(keys(findings)).toEqual([
      'exposure-sensitive-column:User.passwordHash:app/Http/Controllers/UserController.ts:UserController.show',
      'exposure-sensitive-column:User.rememberToken:app/Http/Controllers/UserController.ts:UserController.show',
      'exposure-sensitive-column:User.apiKey:app/Http/Controllers/UserController.ts:UserController.show',
    ])
    expect(findings[0]).toMatchObject({ status: 'warn', filePath: 'app/Http/Controllers/UserController.ts', line: 7 })
  })

  it('drops a finding whose sink line, or the line above, carries guren-audit-ignore', async () => {
    const { findings } = await audit({
      'app/Http/Controllers/UserController.ts': controller(`  async show() {
    const user = await User.findOrFail(1)
    // guren-audit-ignore -- an operator-only debug page
    return this.inertia('users/Show', { user })
  }`),
    })

    expect(findings).toEqual([])
  })

  it("reads serialize() as the model's output columns, and a picked column by name", async () => {
    const { findings } = await audit({
      'app/Http/Controllers/UserController.ts': controller(`  async show() {
    const user = await User.findOrFail(1)
    const { email } = user
    return this.json({ user: User.serialize(user), email, key: user.apiKey })
  }`),
    })

    expect(keys(findings)).toEqual([
      'exposure-sensitive-column:User.apiKey:app/Http/Controllers/UserController.ts:UserController.show',
    ])
    expect(findings[0]!.message).toContain('through serialize()')
  })

  it("reads a resource's toArray() and names the routes of the actions sending it", async () => {
    const route = { method: 'GET', path: '/users/:id', controller: { name: 'UserController', action: 'show' }, chainAuthorizes: false } as AuditedRoute
    const { findings } = await audit({
      'app/Http/Resources/UserResource.ts': `import { JsonResource } from '@guren/core'
import { User } from '../../Models/User'

export class UserResource extends JsonResource<User> {
  toArray() {
    return { id: this.resource.id, token: this.resource.rememberToken }
  }
}
`,
      'app/Http/Controllers/UserController.ts': `import { Controller } from '@guren/core'
import { User } from '../../Models/User'
import { UserResource } from '../Resources/UserResource'

export default class UserController extends Controller {
  async show() {
    const user = await User.findOrFail(1)
    return this.json(new UserResource(user).toJSON())
  }
}
`,
    }, { routes: [route] })

    expect(keys(findings)).toEqual(['exposure-sensitive-column:User.rememberToken:app/Http/Resources/UserResource.ts:UserResource'])
    expect(findings[0]!.message).toContain('served by GET /users/:id, with no authorization on the chain')
  })

  it('judges auth.user() only when the introspected provider is the model provider', async () => {
    const files = {
      'app/Http/Controllers/UserController.ts': controller(`  async me() {
    const user = await this.auth.user()
    return this.json({ user })
  }`),
    }

    const sanitized = await audit(files, { manifest: manifest(MODEL_PROVIDER) })
    expect(keys(sanitized.findings)).toEqual(['exposure-sensitive-column:User.apiKey:app/Http/Controllers/UserController.ts:UserController.me'])

    const custom = await audit(files, { manifest: manifest({ ...MODEL_PROVIDER, providers: { users: { kind: 'custom', hasher: null, algorithm: null, requiresBun: null } } }) })
    expect(custom.findings).toEqual([])
    expect(custom.report?.unread.map((entry) => entry.reason)).toEqual(['auth.user() is not judged: a custom user provider is registered, which need not strip credential columns'])

    const none = await audit(files)
    expect(none.report?.unread[0]?.reason).toBe('auth.user() is not judged: the app was not introspected, so which user provider auth.user() reads is unknown')
  })

  it('never reads a value it lost track of as clean', async () => {
    const cases: Array<[string, string]> = [
      ['a reassigned local', `    let out = {}
    out = await User.findOrFail(1)
    return this.json(out)`],
      ['an object written through', `    const out = {}
    out.user = await User.findOrFail(1)
    return this.json({ ...out })`],
      ['a member of an object literal', `    const u = await User.findOrFail(1)
    const out = { user: u }
    return this.json(out.user)`],
      ['a function prop', `    const u = await User.findOrFail(1)
    return this.inertia('users/Show', { user: async () => u })`],
      ['a concatenation', `    const u = await User.findOrFail(1)
    return this.json('hash=' + u.passwordHash)`],
      ['a destructuring default', `    const u = await User.findOrFail(1)
    const { x = u.passwordHash } = {}
    return this.json(x)`],
    ]
    for (const [label, body] of cases) {
      const { findings, report } = await audit({ 'app/Http/Controllers/UserController.ts': controller(`  async show() {\n${body}\n  }`) })
      expect({ label, judged: findings.length + (report?.unread.length ?? 0) > 0 }).toEqual({ label, judged: true })
    }
  })

  it('reads an expression-bodied toArray field and the fallback whenLoaded() returns', async () => {
    const resource = (body: string) => `import { JsonResource } from '@guren/core'
import { User } from '../../Models/User'

export class UserResource extends JsonResource<User> {
${body}
}
`
    const field = await audit({ 'app/Http/Controllers/UserController.ts': controller(''), 'app/Http/Resources/UserResource.ts': resource('  toArray = () => ({ hash: this.resource.passwordHash })') })
    expect(keys(field.findings)).toEqual(['exposure-sensitive-column:User.passwordHash:app/Http/Resources/UserResource.ts:UserResource'])

    const fallback = await audit({
      'app/Http/Controllers/UserController.ts': controller(''),
      'app/Http/Resources/UserResource.ts': resource(`  toArray() {
    return { hash: this.whenLoaded('posts', () => null, this.resource.passwordHash) }
  }`),
    })
    expect(keys(fallback.findings)).toEqual(['exposure-sensitive-column:User.passwordHash:app/Http/Resources/UserResource.ts:UserResource'])
  })

  it('suppresses one sink without hiding the next one in the same action', async () => {
    const { findings } = await audit({
      'app/Http/Controllers/UserController.ts': controller(`  async show() {
    const u = await User.findOrFail(1)
    if (u.id === 0) {
      // guren-audit-ignore -- shown to operators only
      return this.json({ key: u.apiKey })
    }
    return this.json({ key: u.apiKey })
  }`),
    })

    expect(findings.map((finding) => finding.line)).toEqual([11])
  })

  it('follows the initializer over a type annotation, and leaves an unreadable hidden list unjudged', async () => {
    const annotated = await audit({
      'app/Http/Controllers/UserController.ts': `import { Controller } from '@guren/core'
import { User, type UserRecord } from '../../Models/User'

export default class UserController extends Controller {
  async me() {
    const user: UserRecord | null = await this.auth.user()
    return this.json({ user })
  }
}
`,
    }, { manifest: manifest(MODEL_PROVIDER) })
    expect(keys(annotated.findings)).toEqual(['exposure-sensitive-column:User.apiKey:app/Http/Controllers/UserController.ts:UserController.me'])

    const unreadable = await audit({
      'app/Models/User.ts': USER_MODEL.replace("hidden: ['passwordHash', 'rememberToken'],", 'hidden: HIDDEN,'),
      'app/Http/Controllers/UserController.ts': controller(`  async show() {
    const user = await User.findOrFail(1)
    return this.json({ email: user.email })
  }`),
    })
    expect(unreadable.findings).toEqual([])
    expect(unreadable.report?.unread.map((entry) => entry.reason)).toEqual(["User's hidden list could not be read"])
  })

  it('lists a value it cannot follow as unread, and request input as carrying nothing', async () => {
    const { findings, report } = await audit({
      'app/Http/Controllers/UserController.ts': controller(`  async store() {
    const { name } = await this.validateBody(schema)
    return this.json({ name, found: await lookup(name), query: this.request.query('q') })
  }`),
    })

    expect(findings).toEqual([])
    expect(report?.unread).toEqual([{ file: 'app/Http/Controllers/UserController.ts', line: 7, where: 'UserController.store', expression: 'lookup(name)', reason: 'the reader could not follow this value' }])
  })
})
