import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { authMiddlewareVerdict, runAudit, LINK_BUILDER_PATTERN, type AuditReport } from '../src/audit'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

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

  it.each([
    ['input', `const title = await this.input<string>('title')`],
    ['input with a nested type argument', `const meta = await this.input<Record<string, unknown>>('meta')`],
    ['only', `const data = await this.only('title', 'body')`],
    ['except', `const data = await this.except('id')`],
    // file()/files() are req.parseBody() underneath, which this rule has
    // always flagged when called directly.
    ['file', `const avatar = await this.file('avatar')`],
    ['files', `const attachments = await this.files('attachments')`],
  ])('fails when the body is read through this.%s() without validation', async (_accessor, read) => {
    const workspace = await createTempWorkspace('guren-cli-audit-accessor-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController extends Controller {
  async store() {
    ${read}
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
      expect(validation!.status).toBe('fail')
      expect(validation!.suggestion).toContain('validateBody')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes validation when the controller only checks the body for a key', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-has-')

    try {
      await writeController(
        workspace.dir,
        'PostController',
        `export default class PostController extends Controller {
  async store() {
    if (await this.has('draft')) {
      return this.redirect('/drafts')
    }
    return this.redirect('/posts')
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
      // has() consumes the body but yields only a boolean, so no unvalidated
      // value reaches the app and validateBody() would be the wrong advice.
      expect(validation!.status).toBe('pass')
      // ...but the action does read the body, so the report must not claim otherwise.
      expect(validation!.message).not.toContain('does not consume')
      expect(validation!.message).toContain('only tests the request body for a key')
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

  it('warns when middleware is only named like an auth guard (unverifiable)', async () => {
    // Pre-capability audits passed any middleware whose *name* matched
    // /auth/i. The name alone proves nothing — this alias is never even
    // registered — so with capability-aware servers this is now a warn.
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
      expect(authz!.status).toBe('warn')
      expect(authz!.message).toContain('not one the framework recognizes')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes authz for stamped guards, inline or aliased under any name', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-authz-capability-')

    try {
      await writeRoutes(
        workspace.dir,
        `const guard = async (c: any, next: any) => next()
Object.defineProperty(guard, Symbol.for('guren.capabilities'), {
  value: { authentication: { mode: 'required' } },
})
export default function registerRoutes(router: any) {
  router.aliasMiddleware('member', guard)
  router.delete('/posts/:id', (c: any) => null, guard)
  router.put('/posts/:id', (c: any) => null).middleware('member')
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const inline = report.findings.find(f => f.key === 'authz:DELETE /posts/:id')
      expect(inline!.status).toBe('pass')
      expect(inline!.message).toContain('verified via middleware capabilities')

      const aliased = report.findings.find(f => f.key === 'authz:PUT /posts/:id')
      expect(aliased!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not count guest-only guards as protection', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-authz-guest-')

    try {
      await writeRoutes(
        workspace.dir,
        `const guard = async (c: any, next: any) => next()
Object.defineProperty(guard, Symbol.for('guren.capabilities'), {
  value: { authentication: { mode: 'guest-only' } },
})
export default function registerRoutes(router: any) {
  router.delete('/posts/:id', (c: any) => null, guard)
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      const authz = report.findings.find(f => f.key === 'authz:DELETE /posts/:id')
      expect(authz!.status).toBe('warn')
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

  it('detects hardcoded credentials inside a module (RFC 0002)', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-secret-module-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/config.ts'),
        `export const apiKey = 'sk-live-1234567890abcdef'\n`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const secret = report.findings.find(f => f.key.startsWith('secret:modules/billing/config.ts'))
      expect(secret).toBeDefined()
      expect(secret!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it.each([
    ['reads the body raw', 'const criteria = await this.request.json()', 'fail'],
    ['validates the body', 'const criteria = await this.validateBody(SearchSchema)', 'pass'],
  ] as const)('checks QUERY body validation (%s) without demanding auth', async (_variant, read, expected) => {
    const workspace = await createTempWorkspace('guren-cli-audit-query-')

    try {
      await writeController(
        workspace.dir,
        'SearchController',
        `export default class SearchController {
  async index() {
    ${read}
    return null
  }
}`,
      )
      await writeRoutes(
        workspace.dir,
        `class SearchController {
  async index() { return null }
}
export default function registerRoutes(router: any) {
  router.query('/posts/search', [SearchController, 'index'])
}`,
      )

      const report = await runAudit({ cwd: workspace.dir })

      expect(report.routesAnalyzed).toBe(true)
      const validation = report.findings.find(f => f.key === 'validation:QUERY /posts/search')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe(expected)
      // QUERY is safe (RFC 10008), so no mutating-route auth finding at all.
      const authz = report.findings.find(f => f.key === 'authz:QUERY /posts/search')
      expect(authz).toBeUndefined()
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

  describe('request-derived link URLs', () => {
    /** Findings this rule raised against fixture files (not the `:none` pass row). */
    function hostFindings(report: AuditReport) {
      return report.findings.filter(f => f.key.startsWith('request-host-url:app/'))
    }

    /** Audit a throwaway workspace built from path → content, cleaning up after. */
    async function withWorkspace(files: Record<string, string>): Promise<AuditReport> {
      const workspace = await createTempWorkspace('guren-cli-audit-request-host-')
      try {
        await writeWorkspaceFiles(workspace.dir, files)
        return await runAudit({ cwd: workspace.dir })
      } finally {
        await workspace.cleanup()
      }
    }

    const CONTROLLER = 'app/Http/Controllers/Auth/ForgotPasswordController.ts'

    // The pre-fix ForgotPasswordController body, verbatim: an unauthenticated
    // attacker POSTing with a forged Host had the app mail the victim a real
    // single-use token pointing at the attacker's server.
    const vulnerableController = [
      `import { Controller, createPasswordResetToken, buildPasswordResetUrl } from '@guren/core'`,
      ``,
      `export default class ForgotPasswordController extends Controller {`,
      `  async store(): Promise<Response> {`,
      `    const { email } = await this.validateBody(ForgotPasswordSchema)`,
      `    const { token } = await createPasswordResetToken(email, passwordResetStore)`,
      `    const resetUrl = buildPasswordResetUrl(\`\${new URL(this.request.url).origin}/reset-password\`, token, email)`,
      `    await SendPasswordResetEmailJob.dispatch({ email, resetUrl })`,
      `  }`,
      `}`,
    ].join('\n') + '\n'

    it('warns when a reset link is built from the request host', async () => {
      const report = await withWorkspace({ [CONTROLLER]: vulnerableController })

      const found = hostFindings(report)
      expect(found).toHaveLength(1)
      expect(found[0]!.status).toBe('warn')
      expect(found[0]!.line).toBe(7)
      expect(found[0]!.suggestion).toContain('APP_URL')
      // Classified so --json consumers and the console prefix stay stable.
      expect(found[0]!.classifications?.map(c => c.id).sort()).toEqual(['A07', 'CWE-640'])
      // The rule fires once per line, not once per matching pattern.
      expect(report.findings.find(f => f.key === 'request-host-url:none')).toBeUndefined()
    })

    // buildOAuthRedirectUrl is a literal alias of buildTokenUrl and is exported
    // from @guren/core; missing it made the audit report an affirmative pass on
    // the exact exploit. See the drift test at the end of this block.
    it('warns when an OAuth redirect link is built from the request host', async () => {
      const report = await withWorkspace({
        [CONTROLLER]: [
          `import { buildOAuthRedirectUrl } from '@guren/core'`,
          `const link = buildOAuthRedirectUrl(\`\${new URL(this.request.url).origin}/oauth/finish\`, token, email)`,
        ].join('\n') + '\n',
      })

      expect(hostFindings(report)).toHaveLength(1)
    })

    it('warns when the request host header feeds a link builder', async () => {
      const report = await withWorkspace({
        [CONTROLLER]: [
          `import { buildVerificationUrl } from '@guren/core'`,
          `export default class C extends Controller {`,
          `  async store() {`,
          `    const host = this.request.header('host')`,
          `    return buildVerificationUrl(\`https://\${host}/verify-email\`, token, email)`,
          `  }`,
          `}`,
        ].join('\n') + '\n',
      })

      const found = hostFindings(report)
      expect(found).toHaveLength(1)
      expect(found[0]!.line).toBe(4)
    })

    // A host read off something the app produced is not the request host.
    it('does not flag a host header read from a response', async () => {
      const report = await withWorkspace({
        [CONTROLLER]: [
          `import { buildVerificationUrl } from '@guren/core'`,
          `const upstreamHost = response.headers.get('host')`,
          `const link = buildVerificationUrl(process.env.APP_URL + '/verify', token, email)`,
        ].join('\n') + '\n',
      })

      expect(hostFindings(report)).toHaveLength(0)
    })

    it('warns when the request URL is passed straight to a link builder', async () => {
      const report = await withWorkspace({
        [CONTROLLER]: [
          `import { buildVerificationUrl } from '@guren/core'`,
          `const link = buildVerificationUrl(this.request.url, token, email)`,
        ].join('\n') + '\n',
      })

      const found = hostFindings(report)
      expect(found).toHaveLength(1)
      expect(found[0]!.line).toBe(2)
    })

    // The two spellings an accessor requirement used to miss: the origin is
    // read a line or more after the URL is parsed.
    it.each([
      ['a hoisted URL object', `    const url = new URL(this.request.url)`],
      ['a destructured origin', `    const { origin } = new URL(this.request.url)`],
    ])('warns when the origin is taken from %s', async (_label, parseLine) => {
      const report = await withWorkspace({
        [CONTROLLER]: [
          `import { buildPasswordResetUrl } from '@guren/core'`,
          `export default class C extends Controller {`,
          `  async store() {`,
          parseLine,
          `    return buildPasswordResetUrl(\`\${origin}/reset-password\`, token, email)`,
          `  }`,
          `}`,
        ].join('\n') + '\n',
      })

      const found = hostFindings(report)
      expect(found).toHaveLength(1)
      expect(found[0]!.line).toBe(4)
    })

    // The exact one-liner the scaffold generates today. `[^)]*` in the
    // direct-pass anchor cannot cross the inner `)` of `appUrl(this.request)`,
    // which is the only thing keeping the sanctioned fix from matching — so
    // this asserts that property rather than leaving it incidental.
    it('does not flag the scaffolded appUrl() one-liner', async () => {
      const report = await withWorkspace({
        [CONTROLLER]: [
          `import { buildVerificationUrl } from '@guren/core'`,
          `import { appUrl } from '../../../Auth/AppUrl.js'`,
          `const verifyUrl = buildVerificationUrl(\`\${appUrl(this.request)}/verify-email/confirm\`, token, user.email)`,
        ].join('\n') + '\n',
      })

      expect(hostFindings(report)).toHaveLength(0)
    })

    // The sanctioned helper `guren add auth` generates. Its non-production
    // fallback returns a request-derived origin on purpose — it is the fix,
    // not the bug, and must stay clean without being exempted by path.
    it('does not flag the AppUrl helper that builds no links', async () => {
      const report = await withWorkspace({
        'app/Auth/AppUrl.ts': [
          `export function appUrl(request: { url: string }): string {`,
          `  const configured = process.env.APP_URL?.trim()`,
          `  if (configured) {`,
          `    const parsed = new URL(configured)`,
          `    return \`\${parsed.origin}\${parsed.pathname.replace(/\\/+$/, '')}\``,
          `  }`,
          `  if (process.env.NODE_ENV === 'production') {`,
          `    throw new Error('APP_URL is not set.')`,
          `  }`,
          `  return new URL(request.url).origin`,
          `}`,
        ].join('\n') + '\n',
      })

      expect(hostFindings(report)).toHaveLength(0)
      expect(report.findings.find(f => f.key === 'request-host-url:none')?.status).toBe('pass')
    })

    // Reading the path off the request URL is not taking its host. The fixture
    // calls a builder on purpose, so the gate passes and only the anchor can
    // decide — without it this would prove nothing about the anchor at all.
    it('does not flag a request URL parsed for its path inside a builder file', async () => {
      const report = await withWorkspace({
        'app/Http/Middleware/canonical-host.ts': [
          `import { buildVerificationUrl } from '@guren/core'`,
          `export const middleware = defineMiddleware(async (c, next) => {`,
          `  const path = new URL(c.req.url).pathname`,
          `  if (path === '/verify') return c.redirect(buildVerificationUrl(process.env.APP_URL + '/v', t))`,
          `  return next()`,
          `})`,
        ].join('\n') + '\n',
      })

      expect(hostFindings(report)).toHaveLength(0)
    })

    it('suppresses the finding with guren-audit-ignore', async () => {
      const report = await withWorkspace({
        [CONTROLLER]: vulnerableController.replace(
          '    const resetUrl =',
          '    // guren-audit-ignore -- internal admin link, never emailed\n    const resetUrl =',
        ),
      })

      expect(hostFindings(report)).toHaveLength(0)
    })

    // The audit reads whatever source the app contains, and CI runs it over
    // examples/blog on fork pull requests — so one crafted line must not hang
    // it. Many `new URL(req.url` runs with no `)` between them is the shape
    // that blows up; it also carries a builder call, so the gate lets it
    // through. Measured on this exact input: 6918ms with `[^)]*`, 5ms with
    // `[^)]{0,200}`. The threshold sits between the two, so dropping the
    // bounds fails this test rather than merely slowing it down.
    it('rejects a pathological line without catastrophic backtracking', async () => {
      const pathological = 'const x = new URL(' + 'new URL(req.url '.repeat(1200) + '\n'

      const started = Bun.nanoseconds()
      const report = await withWorkspace({
        [CONTROLLER]: `import { buildPasswordResetUrl } from '@guren/core'\n${pathological}`,
      })
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6

      expect(elapsedMs).toBeLessThan(1500)
      expect(hostFindings(report)).toHaveLength(0)
    })

    // The gate is a hand-maintained name list, so a builder added to
    // @guren/core reaches users as an affirmative `pass` — which is how
    // buildOAuthRedirectUrl was missed. This fails when a fifth one lands.
    it('covers every build*Url that @guren/core exports', async () => {
      const core = await import('@guren/core')
      const exported = Object.keys(core).filter(name => /^build[A-Za-z]*Url$/.test(name))

      // Builds the *provider's* authorize URL, not a link the app mails to a
      // user. A request-derived redirect_uri there is a real risk but a
      // different one, and this rule's wording would misdescribe it.
      const excluded = new Set(['buildOAuthAuthorizeUrl'])

      expect(exported.length).toBeGreaterThan(0)
      for (const name of exported) {
        expect(LINK_BUILDER_PATTERN.test(name) || excluded.has(name)).toBe(true)
      }
    })
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

  it('detects an authenticatable base through a mixin wrapper', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-mass-mixin-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `import { AuthenticatableModel, defineModel, SoftDeletes } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends SoftDeletes(defineModel(users, {
  base: AuthenticatableModel,
})) {}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const user = report.findings.find(f => f.key === 'mass-assignment:User')
      expect(user).toBeDefined()
      expect(user!.status).toBe('pass')
      expect(user!.message).toContain('AuthenticatableModel')
    } finally {
      await workspace.cleanup()
    }
  })

  it('counts a fillable passed as a defineModel option', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-mass-option-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/Post.ts'),
        `import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts, {
  fillable: ['title', 'body'],
}) {}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const post = report.findings.find(f => f.key === 'mass-assignment:Post')
      expect(post).toBeDefined()
      expect(post!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('counts hidden passed as a defineModel option, with static shadowing it', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-option-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, text } from 'drizzle-orm/pg-core'
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `import { defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends defineModel(users, {
  hidden: ['passwordHash'],
}) {}`,
        'utf8',
      )
      // Same option, but a static declaration shadows it — the runtime
      // serializes with the static list, so the audit must too.
      await writeFile(
        join(workspace.dir, 'app/Models/Shadowed.ts'),
        `import { defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class Shadowed extends defineModel(users, {
  hidden: ['passwordHash'],
}) {
  static override hidden = ['email']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const viaOption = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(viaOption).toBeDefined()
      expect(viaOption!.status).toBe('pass')

      const shadowed = report.findings.find(f => f.key === 'hidden-columns:Shadowed')
      expect(shadowed).toBeDefined()
      expect(shadowed!.status).toBe('warn')
      expect(shadowed!.message).toContain('passwordHash')
    } finally {
      await workspace.cleanup()
    }
  })

  it('stays conservative when the runtime-winning declaration is unreadable', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-unreadable-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, text } from 'drizzle-orm/pg-core'
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      // The static shadows the option at runtime but its value cannot be
      // read — the option's list must NOT be reported as what serializes.
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `import { defineModel } from '@guren/core'
import { users } from '../../db/schema.js'
import { HIDDEN } from './config.js'

export class User extends defineModel(users, {
  hidden: ['passwordHash'],
}) {
  static override hidden = HIDDEN
}`,
        'utf8',
      )
      // A spread makes the literal unreadable too — a partial read of
      // ['passwordHash', ...] would also be wrong in the other direction.
      await writeFile(
        join(workspace.dir, 'app/Models/Spread.ts'),
        `import { defineModel } from '@guren/core'
import { users } from '../../db/schema.js'
import { EXTRA } from './config.js'

export class Spread extends defineModel(users, {
  hidden: ['passwordHash', ...EXTRA],
}) {}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const shadowedByUnreadable = report.findings.find(f => f.key === 'hidden-columns:User')
      expect(shadowedByUnreadable).toBeDefined()
      expect(shadowedByUnreadable!.status).toBe('warn')

      const spread = report.findings.find(f => f.key === 'hidden-columns:Spread')
      expect(spread).toBeDefined()
      expect(spread!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not count `fillable: undefined` as mass-assignment protection', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-mass-undef-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/Post.ts'),
        `import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts, {
  fillable: undefined,
}) {}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const post = report.findings.find(f => f.key === 'mass-assignment:Post')
      expect(post).toBeDefined()
      expect(post!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves the table from defineModel, not just from `static table`', async () => {
    // A model that binds its table through defineModel() used to fall out of
    // this check entirely — the table never resolved, so no column was ever
    // compared against `hidden`.
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-define-model-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, text } from 'drizzle-orm/pg-core'
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
}) {
  static guarded = ['id', 'passwordHash']
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

  it('checks sensitive columns for a model backed by a module schema (RFC 0002)', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-hidden-module-')

    try {
      // make:module wires modules/<name>/db/schema.ts into the root
      // db/schema.ts via `export * from ...` — the table itself is declared
      // in the module's schema file, not the root one.
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export * from '../modules/billing/db/schema'\n`, 'utf8')

      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/db/schema.ts'),
        `import { pgTable, text } from 'drizzle-orm/pg-core'
export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  cardToken: text('card_token').notNull(),
})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'modules/billing/app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'),
        `export class Invoice {
  static table = invoices
  static fillable = ['title']
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const hidden = report.findings.find(f => f.key === 'hidden-columns:Invoice')
      expect(hidden).toBeDefined()
      expect(hidden!.status).toBe('warn')
      expect(hidden!.message).toContain('cardToken')
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
      expect(hidden!.suggestion).toContain('visible allowlist overrides hidden')
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

  it('reports a structured finding — not just a console warning — when a module fails to load', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-module-load-fail-')

    try {
      await writeRoutes(workspace.dir, `export default function registerRoutes(_router: any) {}`)

      // A module directory whose index.ts fails to import (references a
      // file that doesn't exist) must not make the audit report look clean —
      // its routes went entirely unchecked.
      await mkdir(join(workspace.dir, 'modules/billing'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `import { registerBillingRoutes } from './does-not-exist'
export const billingModule = { name: 'billing', providers: [], routes: registerBillingRoutes }`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      expect(report.routesAnalyzed).toBe(true)
      const moduleWarning = report.findings.find(f => f.key.startsWith('routes:module-load:'))
      expect(moduleWarning).toBeDefined()
      expect(moduleWarning!.status).toBe('warn')
      expect(moduleWarning!.message).toContain('modules/billing/index.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when two controllers across different modules share a class name', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-controller-collision-')

    try {
      await writeRoutes(workspace.dir, `export default function registerRoutes(_router: any) {}`)

      await mkdir(join(workspace.dir, 'modules/billing/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Http/Controllers/PostController.ts'),
        `export default class PostController {
  async store() {
    const data = await this.validateBody(schema)
    return null
  }
}`,
        'utf8',
      )

      await mkdir(join(workspace.dir, 'modules/inventory/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/inventory/app/Http/Controllers/PostController.ts'),
        `export default class PostController {
  async store() {
    const data = await this.request.json()
    return null
  }
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const collision = report.findings.find(f => f.key === 'controller-name-collision:PostController')
      expect(collision).toBeDefined()
      expect(collision!.status).toBe('fail')
      expect(collision!.message).toContain('modules/billing/app/Http/Controllers/PostController.ts')
      expect(collision!.message).toContain('modules/inventory/app/Http/Controllers/PostController.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('audits mutating routes registered inside a module (RFC 0002), not just the top-level routes file', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-module-')

    try {
      // Top-level routes file has no routes of its own — the mutating route
      // under test lives entirely inside modules/billing/.
      await writeRoutes(
        workspace.dir,
        `export default function registerRoutes(_router: any) {}`,
      )

      await mkdir(join(workspace.dir, 'modules/billing/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Http/Controllers/InvoiceController.ts'),
        `export default class InvoiceController {
  async store() {
    const data = await this.request.json()
    return null
  }
}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/routes.ts'),
        `class InvoiceController {
  async store() { return null }
}
export function registerBillingRoutes(router: any) {
  router.post('/invoices', [InvoiceController, 'store'])
}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `import { registerBillingRoutes } from './routes'

export const billingModule = {
  name: 'billing',
  providers: [],
  routes: registerBillingRoutes,
}`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      expect(report.routesAnalyzed).toBe(true)
      const validation = report.findings.find(f => f.key === 'validation:POST /invoices')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('fail')
      expect(validation!.message).toContain('InvoiceController')
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

describe('finding classifications', () => {
  it('tags rule findings with versioned standards and leaves infra findings untagged', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-taxonomy-')

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
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/leak.ts'),
        `export const apiKey = 'sk-live-abcdef1234567890'\n`,
        'utf8',
      )

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find(f => f.key === 'validation:POST /posts')
      expect(validation!.classifications).toEqual([
        { standard: 'OWASP Top 10', version: '2021', id: 'A03', name: 'Injection' },
        { standard: 'CWE', id: 'CWE-20', name: 'Improper Input Validation' },
      ])

      const authz = report.findings.find(f => f.key === 'authz:POST /posts')
      expect(authz!.classifications?.[0]).toEqual({
        standard: 'OWASP Top 10',
        version: '2021',
        id: 'A01',
        name: 'Broken Access Control',
      })

      const secret = report.findings.find(f => f.key.startsWith('secret:src/leak.ts'))
      expect(secret).toBeDefined()
      expect(secret!.classifications?.map(c => c.id)).toEqual(['A07', 'CWE-798'])

      // Passing findings carry the rule's classification too — the taxonomy
      // describes the check, not the failure.
      const massAssignmentPass = report.findings.find(f => f.key === 'raw-sql:none')
      expect(massAssignmentPass!.classifications?.[0]?.id).toBe('A03')

      // Infrastructure findings (config load, module load) are not security
      // rules and stay untagged.
      const infra = report.findings.filter(f => f.key.startsWith('routes:') || f.key.startsWith('audit-config:'))
      for (const entry of infra) {
        expect(entry.classifications).toBeUndefined()
      }
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('authMiddlewareVerdict', () => {
  const required = { authentication: { mode: 'required' } } as const

  it('verifies capability-carrying routes regardless of names', () => {
    expect(authMiddlewareVerdict({ middlewareNames: [], capabilities: required })).toBe('verified')
    expect(authMiddlewareVerdict({ middlewareNames: ['member'], capabilities: required })).toBe('verified')
  })

  it('falls back to the name heuristic only for pre-capability servers', () => {
    // Old server: no capabilities field at all — the name keeps counting so
    // a newer CLI does not flood a not-yet-upgraded app with false warns.
    expect(authMiddlewareVerdict({ middlewareNames: ['auth'] })).toBe('legacy-name-match')
    expect(authMiddlewareVerdict({ middlewareNames: ['member'] })).toBe('none')
    // New server: empty capabilities means "checked, nothing recognized".
    expect(authMiddlewareVerdict({ middlewareNames: ['auth'], capabilities: {} })).toBe('unverified-auth-name')
    expect(authMiddlewareVerdict({ middlewareNames: ['member'], capabilities: {} })).toBe('none')
  })

  it('treats guest-only as unprotected', () => {
    expect(
      authMiddlewareVerdict({
        middlewareNames: [],
        capabilities: { authentication: { mode: 'guest-only' } },
      }),
    ).toBe('none')
  })
})
