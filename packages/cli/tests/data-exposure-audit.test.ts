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
      'exposure-sensitive-column:User.passwordHash:UserController.show',
      'exposure-sensitive-column:User.rememberToken:UserController.show',
      'exposure-sensitive-column:User.apiKey:UserController.show',
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
      'exposure-sensitive-column:User.apiKey:UserController.show',
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

    expect(keys(findings)).toEqual(['exposure-sensitive-column:User.rememberToken:UserResource'])
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
    expect(keys(sanitized.findings)).toEqual(['exposure-sensitive-column:User.apiKey:UserController.me'])

    const custom = await audit(files, { manifest: manifest({ ...MODEL_PROVIDER, providers: { users: { kind: 'custom', hasher: null, algorithm: null, requiresBun: null } } }) })
    expect(custom.findings).toEqual([])
    expect(custom.report?.unread.map((entry) => entry.reason)).toEqual(['auth.user() is not judged: a custom user provider is registered, which need not strip credential columns'])

    const none = await audit(files)
    expect(none.report?.unread[0]?.reason).toBe('auth.user() is not judged: the app was not introspected, so which user provider auth.user() reads is unknown')
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
