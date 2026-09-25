import { describe, expect, it } from 'bun:test'
import { runAudit, type AuditReport } from '../src/audit'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

/** Audit a throwaway workspace built from path → content, cleaning up after. */
async function withWorkspace(files: Record<string, string>): Promise<AuditReport> {
  const workspace = await createTempWorkspace('guren-cli-audit-authorization-')
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    return await runAudit({ cwd: workspace.dir })
  } finally {
    await workspace.cleanup()
  }
}

const KEY = 'policy:DELETE /posts/:id'

const routes = `
import { Router } from '@guren/core'

class PostController {
  async destroy() { return null }
}

export default function registerRoutes(router: Router) {
  router.delete('/posts/:id', [PostController, 'destroy'])
}
`

const model = `import { defineModel } from '@guren/core'
import { posts } from '../../db/schema'

export class Post extends defineModel(posts) {}
`

const policy = `import { Policy, type AuthUser } from '@guren/core'

export class PostPolicy extends Policy {
  update(user: AuthUser | null, post: { authorId: number }): boolean {
    return user !== null && Number(user.id) === post.authorId
  }

  delete(user: AuthUser | null, post: { authorId: number }): boolean {
    return user !== null && Number(user.id) === post.authorId
  }
}
`

const controller = (body: string) => `import { Controller } from '@guren/core'
import { Post } from '../../Models/Post'

export default class PostController extends Controller {
  async destroy() {
${body}
  }
}
`

/** The blog scaffold's destroy with its authorize() line removed: the reproduction. */
const UNAUTHORIZED_DESTROY = `    const post = await Post.findOrFail(1)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')`

const app = (files: Record<string, string> = {}): Record<string, string> => ({
  'routes/web.ts': routes,
  'app/Models/Post.ts': model,
  'app/Policies/PostPolicy.ts': policy,
  ...files,
})

describe('policy authorization on mutating routes', () => {
  it('warns when a mutating action touches a model with a policy and never authorizes', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('warn')
    expect(authorization?.message).toContain('PostController.destroy')
    expect(authorization?.message).toContain('Post (PostPolicy)')
    expect(authorization?.message).toContain('app/Http/Controllers/PostController.ts:5')
    expect(authorization?.suggestion).toContain("this.authorize('<ability>', [Post, post])")
    expect(authorization?.suggestion).toContain('PostPolicy declares update, delete')
    expect(authorization?.filePath).toBe('app/Http/Controllers/PostController.ts')
    // Route-level: no line, so config/audit.ts is the structured suppression.
    expect(authorization?.line).toBeUndefined()
    expect(authorization?.classifications?.map((c) => c.id)).toEqual(['A01', 'CWE-862'])
    expect(report.failCount).toBe(0)
  })

  it('passes when the action calls this.authorize()', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(
        `    const post = await Post.findOrFail(1)
    await this.authorize('delete', [Post, post])
    await Post.delete({ id: post.id })
    return this.redirect('/posts')`,
      ),
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('pass')
    expect(authorization?.message).toContain('consults a policy')
  })

  // can() answers rather than throws, but the action visibly asked the policy.
  it('passes when the action branches on this.can()', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(
        `    const post = await Post.findOrFail(1)
    if (!(await this.can('delete', [Post, post]))) return this.redirect('/posts')
    await Post.delete({ id: post.id })
    return this.redirect('/posts')`,
      ),
    }))

    expect(report.findings.find((f) => f.key === KEY)?.status).toBe('pass')
  })

  it('passes when the action calls the policy class itself', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { Post } from '../../Models/Post'
import { PostPolicy } from '../../Policies/PostPolicy'

export default class PostController extends Controller {
  async destroy() {
    const post = await Post.findOrFail(1)
    if (!new PostPolicy().delete(await this.auth.user(), post)) return this.redirect('/posts')
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }
}
`,
    }))

    expect(report.findings.find((f) => f.key === KEY)?.status).toBe('pass')
  })

  // The stamp authorize()/authorizeResource() carry, without linking the server into the fixture.
  it('passes when the middleware chain carries an authorization capability', async () => {
    const report = await withWorkspace(app({
      'routes/web.ts': `
const guard = async (c: any, next: any) => next()
Object.defineProperty(guard, Symbol.for('guren.capabilities'), {
  value: { authorization: { abilities: ['delete'], mode: 'all' } },
})

class PostController {
  async destroy() { return null }
}

export default function registerRoutes(router: any) {
  router.delete('/posts/:id', [PostController, 'destroy'], guard)
}
`,
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('pass')
    expect(authorization?.message).toContain('middleware')
  })

  // Content-activated: an app with no policy has nothing to consult.
  it('contributes nothing when the app keeps no policy', async () => {
    const report = await withWorkspace({
      'routes/web.ts': routes,
      'app/Models/Post.ts': model,
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    })

    expect(report.findings.some((f) => f.key.startsWith('policy:'))).toBe(false)
  })

  it('does not bind a policy whose name matches no model', async () => {
    const report = await withWorkspace({
      'routes/web.ts': routes,
      'app/Models/Post.ts': model,
      'app/Policies/CommentPolicy.ts': policy.replace('PostPolicy', 'CommentPolicy'),
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    })

    expect(report.findings.some((f) => f.key.startsWith('policy:'))).toBe(false)
  })

  it('passes an action that references no model with a policy', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(
        `    await Comment.delete({ id: 1 })
    return this.redirect('/posts')`,
      ),
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('pass')
    expect(authorization?.message).toContain('names no model')
  })

  // A body the scan never read is a warn, never a pass.
  it('warns rather than passing when the controller source is not among those read', async () => {
    const report = await withWorkspace(app())

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('warn')
    expect(authorization?.message).toContain('could not be verified')
    expect(authorization?.message).toContain('1 model policy')
  })

  it('skips safe methods and guest flows', async () => {
    const report = await withWorkspace(app({
      'routes/web.ts': `
import { Router } from '@guren/core'

class PostController {
  async show() { return null }
  async destroy() { return null }
}

export default function registerRoutes(router: Router) {
  router.get('/posts/:id', [PostController, 'show'])
  router.delete('/register/:id', [PostController, 'destroy'])
}
`,
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    }))

    expect(report.findings.some((f) => f.key.startsWith('policy:'))).toBe(false)
  })

  it('reads neither a model name in a string nor an authorize() in a comment', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(
        `    // await this.authorize('delete', [Post, post])
    const post = await Post.findOrFail(1)
    await Post.delete({ id: post.id })
    return this.redirect('Post deleted')`,
      ),
    }))

    expect(report.findings.find((f) => f.key === KEY)?.status).toBe('warn')

    const stringOnly = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(
        `    await Comment.delete({ id: 1 })
    return this.redirect('Post deleted')`,
      ),
    }))

    expect(stringOnly.findings.find((f) => f.key === KEY)?.message).toContain('names no model')
  })

  it.each([
    ['an aliased import', "import { Post as PostModel } from '../../Models/Post'", 'PostModel.delete({ id: 1 })'],
    ['a default import', "import PostModel from '../../Models/Post'", 'PostModel.delete({ id: 1 })'],
    ['a namespace import', "import * as Models from '../../Models/Post'", 'Models.Post.delete({ id: 1 })'],
  ])('follows %s of the model file', async (_form, importLine, write) => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
${importLine}

export default class PostController extends Controller {
  async destroy() {
    await ${write}
    return this.redirect('/posts')
  }
}
`,
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('warn')
    expect(authorization?.message).toContain('Post (PostPolicy)')
  })

  // The guide's other form: a gate resolved by hand and asked directly.
  it('passes when the action asks the gate itself', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(
        `    const post = await Post.findOrFail(1)
    const gate = this.make('gate').forUser(await this.auth.user())
    if (await gate.denies('delete', post)) return this.redirect('/posts')
    await Post.delete({ id: post.id })
    return this.redirect('/posts')`,
      ),
    }))

    expect(report.findings.find((f) => f.key === KEY)?.status).toBe('pass')
  })

  it('does not read Post inside PostTag as a reference', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(
        `    await PostTag.delete({ id: 1 })
    return this.redirect('/posts')`,
      ),
    }))

    expect(report.findings.find((f) => f.key === KEY)?.message).toContain('names no model')
  })

  // Reported as ignored with the marker as its reason, never dropped: the
  // config path records a reason, and the inline path must not be quieter.
  it('reports the finding ignored under a // guren-audit-ignore above the action', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { Post } from '../../Models/Post'

export default class PostController extends Controller {
  // guren-audit-ignore -- PostService.remove() authorizes
  async destroy() {
${UNAUTHORIZED_DESTROY}
  }
}
`,
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('ignored')
    expect(authorization?.ignoreReason).toBe('guren-audit-ignore -- PostService.remove() authorizes')
    expect(report.findings.filter((f) => f.key.startsWith('policy:') && f.status === 'warn')).toEqual([])
  })

  // Babel attaches every comment above the member, so a marker above a JSDoc block counts too.
  it('reads the marker above a JSDoc block on the action', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { Post } from '../../Models/Post'

export default class PostController extends Controller {
  // guren-audit-ignore -- PostService.remove() authorizes
  /** Removes a post. */
  async destroy() {
${UNAUTHORIZED_DESTROY}
  }
}
`,
    }))

    expect(report.findings.find((f) => f.key === KEY)?.status).toBe('ignored')
  })

  it('is suppressible by key through config/audit.ts', async () => {
    const report = await withWorkspace(app({
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
      'config/audit.ts': `export default {
  ignore: [{ key: '${KEY}', reason: 'PostService.remove() authorizes' }],
}
`,
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('ignored')
    expect(authorization?.ignoreReason).toBe('PostService.remove() authorizes')
  })

  it('recognizes a definePolicy() policy and lists its abilities', async () => {
    const report = await withWorkspace(app({
      'app/Policies/PostPolicy.ts': `import { definePolicy } from '@guren/core'

export const PostPolicy = definePolicy({
  delete: (user, post) => user !== null && user.id === post.authorId,
})
`,
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('warn')
    expect(authorization?.suggestion).toContain('PostPolicy declares delete')
  })

  it('still binds a policy file it cannot read as a policy, and says so', async () => {
    const report = await withWorkspace(app({
      'app/Policies/PostPolicy.ts': `export const PostPolicy = ownerPolicy(['update', 'delete'])\n`,
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    }))

    const authorization = report.findings.find((f) => f.key === KEY)
    expect(authorization?.status).toBe('warn')
    expect(authorization?.suggestion).toContain('could not be read as a policy')
  })

  // `make:adr` and `plan` pair a model with its own module's policy; the audit must agree.
  it('does not pair a root model with a policy of the same name in a module', async () => {
    const report = await withWorkspace({
      'routes/web.ts': routes,
      'app/Models/Post.ts': model,
      'modules/blog/app/Policies/PostPolicy.ts': policy,
      'app/Http/Controllers/PostController.ts': controller(UNAUTHORIZED_DESTROY),
    })

    expect(report.findings.some((f) => f.key.startsWith('policy:'))).toBe(false)
  })

  it('finds a policy and model inside a module', async () => {
    const report = await withWorkspace({
      'routes/web.ts': 'export default function registerRoutes(_router: any) {}\n',
      'modules/billing/index.ts': `import { registerBillingRoutes } from './routes'

export const billingModule = { name: 'billing', providers: [], routes: registerBillingRoutes }
`,
      'modules/billing/routes.ts': `class InvoiceController {
  async destroy() { return null }
}
export function registerBillingRoutes(router: any) {
  router.delete('/invoices/:id', [InvoiceController, 'destroy'])
}
`,
      'modules/billing/app/Models/Invoice.ts': model.replace(/Post/g, 'Invoice').replace('posts', 'invoices'),
      'modules/billing/app/Policies/InvoicePolicy.ts': policy.replace('PostPolicy', 'InvoicePolicy'),
      'modules/billing/app/Http/Controllers/InvoiceController.ts': controller(UNAUTHORIZED_DESTROY)
        .replace(/PostController/g, 'InvoiceController')
        .replace(/Post\b/g, 'Invoice'),
    })

    expect(report.findings.some((f) => f.key.startsWith('routes:module-load:'))).toBe(false)
    const authorization = report.findings.find((f) => f.key === 'policy:DELETE /invoices/:id')
    expect(authorization?.status).toBe('warn')
    expect(authorization?.message).toContain('Invoice (InvoicePolicy)')
  })
})
