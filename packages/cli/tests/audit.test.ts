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
