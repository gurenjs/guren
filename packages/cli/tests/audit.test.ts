import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runAudit } from '../src/audit'
import { createTempWorkspace } from './helpers'

async function writeRoutes(dir: string, contents: string): Promise<void> {
  await mkdir(join(dir, 'routes'), { recursive: true })
  await writeFile(join(dir, 'routes/web.ts'), contents, 'utf8')
}

async function writeController(dir: string, name: string, contents: string): Promise<void> {
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await writeFile(join(dir, `app/Http/Controllers/${name}.ts`), contents, 'utf8')
}

describe('runAudit', () => {
  it('fails when the request body is read without validation', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-validation-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController {
  async store() {
    const data = await this.request.json()
    return null
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class PostController {
  async store() { return null }
}
export default function registerRoutes(router: any) {
  router.post('/posts', [PostController, 'store'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      expect(report.routesAnalyzed).toBe(true)
      const validation = report.findings.find(f => f.key === 'validation:POST /posts')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('fail')
      expect(validation!.suggestion).toContain('validateBody')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes validation when the controller does not consume the body', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-nobody-')

    try {
      await writeController(
        workspace.dir,
        'SessionController',
        `export default class SessionController {
  async destroy() {
    await this.auth.logout()
    return this.redirect('/')
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class SessionController {
  async destroy() { return null }
}
export default function registerRoutes(router: any) {
  router.post('/sessions/end', [SessionController, 'destroy'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find(f => f.key === 'validation:POST /sessions/end')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('pass')
      expect(validation!.message).toContain('does not consume')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when an inline handler has no schema and cannot be analyzed', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-inline-')

    try {
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(router: any) {
  router.post('/items', (c: any) => null)
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find(f => f.key === 'validation:POST /items')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes validation when controller calls validateBody', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-validatebody-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController {
  async store() {
    const data = await this.validateBody(schema)
    return null
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class PostController {
  async store() { return null }
}
export default function registerRoutes(router: any) {
  router.post('/posts', [PostController, 'store'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find(f => f.key === 'validation:POST /posts')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails controller routes that rely on a type-only route body schema', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-typeonly-schema-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController {
  async store() {
    const data = await this.request.json()
    return null
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class PostController {
  async store() { return null }
}
const schema = { safeParse: (value: unknown) => ({ success: true, data: value }) }
export default function registerRoutes(router: any) {
  router.post('/posts', { name: 'posts.store', body: schema }, [PostController, 'store'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find(f => f.key === 'validation:POST /posts')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('fail')
      expect(validation!.message).toContain('type-only')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not count optional auth reads as protection', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-optional-auth-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController {
  async destroy() {
    const user = await this.auth.user()
    return null
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class PostController {
  async destroy() { return null }
}
export default function registerRoutes(router: any) {
  router.delete('/posts/:id', [PostController, 'destroy'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:DELETE /posts/:id')
      expect(authz).toBeDefined()
      expect(authz!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes validation when route attaches a body schema', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-schema-')

    try {
      await writeRoutes(
        workspace.dir,
        `const schema = { safeParse: (value: unknown) => ({ success: true, data: value }) }
export default function registerRoutes(router: any) {
  router.post('/posts', { name: 'posts.store', body: schema }, (c: any) => null)
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find(f => f.key === 'validation:POST /posts')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about mutating routes without authentication', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-authz-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController {
  async destroy() {
    return null
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class PostController {
  async destroy() { return null }
}
export default function registerRoutes(router: any) {
  router.delete('/posts/:id', [PostController, 'destroy'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:DELETE /posts/:id')
      expect(authz).toBeDefined()
      expect(authz!.status).toBe('warn')
      expect(authz!.suggestion).toContain('auth')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes authz when auth middleware protects the route', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-authz-mw-')

    try {
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(router: any) {
  router.delete('/posts/:id', (c: any) => null).middleware('auth')
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:DELETE /posts/:id')
      expect(authz).toBeDefined()
      expect(authz!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes authz when controller calls auth.userOrFail', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-authz-controller-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController {
  async store() {
    const user = await this.auth.userOrFail()
    const data = await this.validateBody(schema)
    return null
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class PostController {
  async store() { return null }
}
export default function registerRoutes(router: any) {
  router.post('/posts', [PostController, 'store'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:POST /posts')
      expect(authz).toBeDefined()
      expect(authz!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('suggests signature verification for unprotected webhook routes', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-webhook-')

    try {
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(router: any) {
  router.post('/webhooks/stripe', (c: any) => null)
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:POST /webhooks/stripe')
      expect(authz).toBeDefined()
      expect(authz!.status).toBe('warn')
      expect(authz!.suggestion).toContain('signature')
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips authz for guest paths like /login', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-guest-')

    try {
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(router: any) {
  router.post('/login', (c: any) => null)
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:POST /login')
      expect(authz).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects hardcoded credentials', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-secret-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/config.ts'),
        `export const apiKey = 'sk-live-1234567890abcdef'\n`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const secret = report.findings.find(f => f.key.startsWith('secret:src/config.ts'))
      expect(secret).toBeDefined()
      expect(secret!.status).toBe('fail')
      expect(secret!.line).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('suppresses findings marked with guren-audit-ignore', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/config.ts'),
        [
          `// guren-audit-ignore -- documented example value`,
          `export const apiKey = 'sk-live-1234567890abcdef'`,
          `export const otherKey = 'sk-live-fedcba0987654321' // guren-audit-ignore`,
        ].join('\n') + '\n',
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const secret = report.findings.find(f => f.key.startsWith('secret:src/config.ts'))
      expect(secret).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores credentials read from process.env', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-env-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/config.ts'),
        `export const apiKey = process.env.API_KEY ?? ''\n`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const secret = report.findings.find(f => f.key.startsWith('secret:src/'))
      expect(secret).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects raw SQL with interpolation', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-rawsql-')

    try {
      await mkdir(join(workspace.dir, 'app/Services'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Services/ReportService.ts'),
        'const rows = await db.execute(sql.raw(`SELECT * FROM users WHERE id = ${userId}`))\n',
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const rawSql = report.findings.find(f => f.key.startsWith('raw-sql:app/Services/ReportService.ts'))
      expect(rawSql).toBeDefined()
      expect(rawSql!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when security defaults are disabled', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-toggle-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `export const app = createApp({ autoCsrf: false })\n`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const toggle = report.findings.find(f => f.key.startsWith('security-toggle:src/app.ts'))
      expect(toggle).toBeDefined()
      expect(toggle!.status).toBe('warn')
      expect(toggle!.message).toContain('autoCsrf')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about models without fillable or guarded', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-mass-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/Post.ts'),
        `export class Post {
  static table = posts
}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `export class User {
  static table = users
  static fillable = ['name', 'email']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const post = report.findings.find(f => f.key === 'mass-assignment:Post')
      expect(post).toBeDefined()
      expect(post!.status).toBe('warn')

      const user = report.findings.find(f => f.key === 'mass-assignment:User')
      expect(user).toBeDefined()
      expect(user!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when a sensitive schema column is not hidden', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-warn-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, text } from 'drizzle-orm/pg-core'
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `export class User {
  static table = users
  static fillable = ['email']
  static hidden = ['passwordHash']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const hidden = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(hidden).toBeDefined()
      expect(hidden!.status).toBe('warn')
      expect(hidden!.message).toContain('rememberToken')
      expect(hidden!.message).not.toContain('passwordHash,')
      expect(hidden!.suggestion).toContain("'rememberToken'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes when all sensitive columns are hidden', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-pass-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `export const users = pgTable('users', {
  id: text('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `export class User {
  static table = users
  static fillable = ['email']
  static override hidden = ['passwordHash']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const hidden = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(hidden).toBeDefined()
      expect(hidden!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes when a visible allowlist excludes sensitive columns', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-visible-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  apiSecret: text('api_secret').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `export class User {
  static table = users
  static fillable = ['email']
  static visible = ['id', 'email']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const hidden = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(hidden).toBeDefined()
      expect(hidden!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when a non-empty visible allowlist re-exposes a hidden sensitive column', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-visible-wins-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `export const users = pgTable('users', {
  id: text('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      // serializeRecord gives a non-empty visible list precedence over hidden.
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `export class User {
  static table = users
  static fillable = ['email']
  static hidden = ['passwordHash']
  static visible = ['id', 'passwordHash']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const hidden = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(hidden).toBeDefined()
      expect(hidden!.status).toBe('warn')
      expect(hidden!.suggestion).toContain('static visible')
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores an empty visible array like the runtime serializer does', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-empty-visible-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `export const users = pgTable('users', {
  id: text('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `export class User {
  static table = users
  static fillable = ['email']
  static visible: string[] = []
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const hidden = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(hidden).toBeDefined()
      expect(hidden!.status).toBe('warn')
      expect(hidden!.message).toContain('passwordHash')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not count commented-out hidden entries', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-comment-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `export const users = pgTable('users', {
  id: text('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `export class User {
  static table = users
  static fillable = ['email']
  static hidden = [
    // 'passwordHash',
  ]
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const hidden = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(hidden).toBeDefined()
      expect(hidden!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('emits no hidden-columns finding without sensitive columns or schema', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-none-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `export const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/Post.ts'),
        `export class Post {
  static table = posts
  static fillable = ['title']
}`,
        'utf8',
      )
      // Model whose table is not in db/schema.ts is skipped silently.
      await writeFile(
        join(workspace.dir, 'app/Models/Audit.ts'),
        `export class Audit {
  static table = audits
  static fillable = ['action']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      expect(report.findings.find(f => f.key === 'hidden-columns:Post')).toBeUndefined()
      expect(report.findings.find(f => f.key === 'hidden-columns:Audit')).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('degrades gracefully when routes cannot be loaded', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-noroutes-')

    try {
      const report = await runAudit({ cwd: workspace.dir })

      expect(report.routesAnalyzed).toBe(false)
      const loadWarning = report.findings.find(f => f.key === 'routes:load')
      expect(loadWarning).toBeDefined()
      expect(loadWarning!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })
})

const WEBHOOK_ROUTE = `export default function registerRoutes(router: any) {
  router.post('/webhooks/stripe', (c: any) => null)
}`

describe('runAudit ignore config', () => {
  async function writeAuditConfig(dir: string, contents: string): Promise<void> {
    await mkdir(join(dir, 'config'), { recursive: true })
    await writeFile(join(dir, 'config/audit.ts'), contents, 'utf8')
  }

  it('ignores a route-level finding matched by key with a reason', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-route-')

    try {
      await writeRoutes(workspace.dir, WEBHOOK_ROUTE)
      await writeAuditConfig(
        workspace.dir,
        `export default {
  ignore: [
    { key: 'authz:POST /webhooks/stripe', reason: 'HMAC signature verified in controller' },
  ],
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:POST /webhooks/stripe')
      expect(authz).toBeDefined()
      expect(authz!.status).toBe('ignored')
      expect(authz!.ignoreReason).toBe('HMAC signature verified in controller')
      expect(report.ignoredCount).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores a model-level finding matched by key', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-model-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/Post.ts'),
        `export default class Post {}`,
        'utf8',
      )
      await writeAuditConfig(
        workspace.dir,
        `export default {
  ignore: [
    { key: 'mass-assignment:Post', reason: 'Seeded internally only, never bound to request input' },
  ],
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const finding = report.findings.find(f => f.key === 'mass-assignment:Post')
      expect(finding).toBeDefined()
      expect(finding!.status).toBe('ignored')
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects an entry targeting a line-level finding (secrets) instead of ignoring it', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-line-level-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/config.ts'),
        `export const apiKey = 'sk-live-1234567890abcdef'\n`,
        'utf8',
      )
      const secretKeyReport = await runAudit({ cwd: workspace.dir })
      const secretKey = secretKeyReport.findings.find(f => f.key.startsWith('secret:src/config.ts'))!.key

      await writeAuditConfig(
        workspace.dir,
        `export default {
  ignore: [
    { key: '${secretKey}', reason: 'trying to suppress a hardcoded credential via config' },
  ],
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const secret = report.findings.find(f => f.key === secretKey)
      expect(secret).toBeDefined()
      expect(secret!.status).toBe('fail')
      const unsupported = report.findings.find(f => f.key === `audit-config:unsupported:${secretKey}`)
      expect(unsupported).toBeDefined()
      expect(unsupported!.suggestion).toContain('guren-audit-ignore')
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores every finding that shares an ignored key, not just the first', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-duplicate-key-')

    try {
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(router: any) {
  router.post('/widgets', (c: any) => null)
  router.post('/widgets', (c: any) => null)
}`,
      )
      await writeAuditConfig(
        workspace.dir,
        `export default {
  ignore: [
    { key: 'authz:POST /widgets', reason: 'both registrations are intentional and reviewed' },
  ],
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const matches = report.findings.filter(f => f.key === 'authz:POST /widgets')
      expect(matches).toHaveLength(2)
      expect(matches.every(f => f.status === 'ignored')).toBe(true)
      expect(report.findings.some(f => f.key.startsWith('audit-config:unused'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports an ignore entry missing a key as invalid', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-missing-key-')

    try {
      await writeRoutes(workspace.dir, WEBHOOK_ROUTE)
      await writeAuditConfig(
        workspace.dir,
        `export default {
  ignore: [
    { reason: 'no key set' },
  ],
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:POST /webhooks/stripe')
      expect(authz!.status).toBe('warn')
      const invalid = report.findings.find(f => f.key === 'audit-config:invalid')
      expect(invalid).toBeDefined()
      expect(invalid!.message).toContain("missing a non-empty 'key'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not apply an ignore entry missing a reason, and warns instead', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-invalid-')

    try {
      await writeRoutes(workspace.dir, WEBHOOK_ROUTE)
      await writeAuditConfig(
        workspace.dir,
        `export default {
  ignore: [
    { key: 'authz:POST /webhooks/stripe', reason: '' },
  ],
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:POST /webhooks/stripe')
      expect(authz!.status).toBe('warn')
      const invalid = report.findings.find(f => f.key === 'audit-config:invalid')
      expect(invalid).toBeDefined()
      expect(invalid!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about an ignore entry that never matched any finding', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-unused-')

    try {
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(router: any) {
  router.post('/login', (c: any) => null)
}`,
      )
      await writeAuditConfig(
        workspace.dir,
        `export default {
  ignore: [
    { key: 'authz:POST /nonexistent', reason: 'stale entry' },
  ],
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const unused = report.findings.find(f => f.key === 'audit-config:unused:authz:POST /nonexistent')
      expect(unused).toBeDefined()
      expect(unused!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when the ignore config fails to load, but still runs the rest of the audit', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-loaderror-')

    try {
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(router: any) {
  router.post('/login', (c: any) => null)
}`,
      )
      await writeAuditConfig(workspace.dir, `throw new Error('boom')`)

      const report = await runAudit({ cwd: workspace.dir })

      const loadError = report.findings.find(f => f.key === 'audit-config:load')
      expect(loadError).toBeDefined()
      expect(loadError!.status).toBe('warn')
      expect(report.routesAnalyzed).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('behaves exactly as before when no ignore config exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-none-')

    try {
      await writeRoutes(workspace.dir, WEBHOOK_ROUTE)

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:POST /webhooks/stripe')
      expect(authz!.status).toBe('warn')
      expect(report.findings.some(f => f.key.startsWith('audit-config:'))).toBe(false)
      expect(report.ignoredCount).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('loads the ignore config from an explicit auditConfigFile path', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-ignore-explicit-path-')

    try {
      await writeRoutes(workspace.dir, WEBHOOK_ROUTE)
      await mkdir(join(workspace.dir, 'custom'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'custom/security-exceptions.ts'),
        `export default {
  ignore: [
    { key: 'authz:POST /webhooks/stripe', reason: 'HMAC signature verified in controller' },
  ],
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir, auditConfigFile: 'custom/security-exceptions.ts' })

      const authz = report.findings.find(f => f.key === 'authz:POST /webhooks/stripe')
      expect(authz!.status).toBe('ignored')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('auth detection with generic type arguments', () => {
  it('recognizes userOrFail calls with type parameters', () => {
    const source = `
export default class TaskController extends Controller {
  async store(): Promise<Response> {
    const user = await this.auth.userOrFail<{ id: number }>()
    const data = await this.validateBody<typeof Schema>(Schema)
    void user
    void data
  }
}
`
    expect(/\bauth\s*\.\s*userOrFail\s*(?:<[^>]*>)?\s*\(/.test(source)).toBe(true)
    expect(/\bvalidateBody(Safe)?\s*(?:<[^>]*>)?\s*\(/.test(source)).toBe(true)
  })
})
