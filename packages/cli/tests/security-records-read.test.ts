import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { readSecurityRecords } from '../src/change/security-records-read'
import { createTempRoot, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

// The records introspect the application in a child, past Bun's 5 s default under a loaded suite.
setDefaultTimeout(60_000)

const WORKSPACE_ZOD = resolve(import.meta.dir, '../node_modules/zod')
let ROOT: string

beforeAll(async () => {
  ROOT = await createTempRoot('guren-security-records-read-')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'records-app', type: 'module' }),
  'bunfig.toml': '[install]\nauto = "disable"\n',
  'src/main.ts': `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({ routes: registerWebRoutes, providers: [] })

export default app
`,
  'routes/web.ts': `import { requireAuthenticated, type Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'
import { PostSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/health', (c) => c.text('ok'))
  router.put('/posts/:id', { name: 'posts.update', body: PostSchema, middlewares: [requireAuthenticated()] }, [PostController, 'update'])
}
`,
  'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { IdSchema } from '../Validators/PostValidator.js'

export class PostController extends Controller {
  async update(): Promise<Response> {
    await this.auth.userOrFail()
    await this.authorize('update', 'Post')
    const { id } = this.validateParams(IdSchema)
    return this.json({ id })
  }
}
`,
  'app/Http/Validators/PostValidator.ts': `import { z } from 'zod'

export const IdSchema = z.object({ id: z.coerce.number().int().positive() })

export const PostSchema = z.object({ title: z.string().min(1) })
`,
}

/** A controller schema declared in place, a contract built from a shared rule, and a schema read through a barrel. */
const BUILT: Record<string, string> = {
  ...FILES,
  'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { z } from 'zod'
import { IdSchema } from '../Validators/index.js'

const ListQuery = z.object({ q: z.string().min(1) })

export class PostController extends Controller {
  async update(): Promise<Response> {
    const { id } = this.validateParams(IdSchema)
    const { q } = this.validateQuery(ListQuery)
    return this.json({ id, q })
  }
}
`,
  'app/Http/Validators/index.ts': "export * from './PostValidator.js'\n",
  'app/Http/Validators/PostValidator.ts': `import { z } from 'zod'

const titleRule = z.string().min(1)

export const IdSchema = z.object({ id: z.coerce.number().int().positive() })

export const PostSchema = z.object({ title: titleRule })
`,
}

async function app(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(ROOT, name)
  await writeWorkspaceFiles(dir, files)
  await linkWorkspaceCore(dir)
  await symlink(WORKSPACE_ZOD, join(dir, 'node_modules', 'zod'), 'dir')
  return dir
}

describe('readSecurityRecords', () => {
  test('reads the chain, the contract and its export, and the action\'s calls of an introspected route', async () => {
    const dir = await app('plain', FILES)

    const records = await readSecurityRecords(dir)

    if ('unreadable' in records) throw new Error(records.unreadable)
    const update = records.routes.find((route) => route.path === '/posts/:id')
    expect(update).toMatchObject({
      method: 'PUT',
      action: 'app/Http/Controllers/PostController.ts#PostController.update',
      middleware: [{ capabilities: { authentication: { mode: 'required' } } }],
      contracts: { body: { exports: ['app/Http/Validators/PostValidator.ts#PostSchema'], declarations: { 'app/Http/Validators/PostValidator.ts#PostSchema': expect.any(String) } } },
      handler: {
        authenticates: true,
        authorizes: [{ member: 'authorize', ability: 'update', subject: "'Post'" }],
        validates: [{ member: 'validateParams', schema: 'app/Http/Validators/PostValidator.ts#IdSchema', declaration: expect.any(String) }],
      },
    })
    expect(update?.handler).not.toHaveProperty('unseen')
    expect(records.routes.find((route) => route.path === '/health')?.handler).toEqual({ unread: 'an inline handler, whose body the reader does not follow' })
  })
  test('changes a digest when a schema loosens where its declaration does not show it', async () => {
    const dir = await app('built', BUILT)
    const read = async () => {
      const records = await readSecurityRecords(dir)
      if ('unreadable' in records) throw new Error(records.unreadable)
      return records.routes.find((route) => route.path === '/posts/:id')!
    }
    const before = await read()
    await writeFile(join(dir, 'app/Http/Validators/PostValidator.ts'), BUILT['app/Http/Validators/PostValidator.ts']!.replace('z.string().min(1)', 'z.string()').replace('.int().positive()', ''))
    await writeFile(join(dir, 'app/Http/Controllers/PostController.ts'), BUILT['app/Http/Controllers/PostController.ts']!.replace("q: z.string().min(1)", 'q: z.string()'))
    const after = await read()

    const validates = (route: typeof before) => ('unread' in route.handler ? [] : route.handler.validates)
    expect(validates(before).map((call) => call.schema)).toEqual(['app/Http/Validators/index.ts#IdSchema', 'app/Http/Controllers/PostController.ts#ListQuery'])
    expect(validates(after).map((call) => call.declaration)).not.toEqual(validates(before).map((call) => call.declaration))
    expect(validates(after)[0]!.declaration).not.toBe(validates(before)[0]!.declaration)
    expect(validates(after)[1]!.declaration).not.toBe(validates(before)[1]!.declaration)
    expect(after.contracts.body?.declarations).not.toEqual(before.contracts.body?.declarations)
  })
  test('digests a call it cannot name, a body it cannot find, and nothing it does not reach', async () => {
    const controller = (body: string) => `import { Controller } from '@guren/core'
import { unrelated } from '../../Unrelated.js'
import { BaseController } from './BaseController.js'

export class PostController extends BaseController {
  async update(): Promise<Response> {
${body}
    return this.json({ unrelated })
  }
}
`
    const base = `import { Controller } from '@guren/core'

export class BaseController extends Controller {
  async destroy(): Promise<Response> {
    await this.authorize('delete', 'Post')
    return this.json({})
  }
}
`
    const files = (body: string, extra: Record<string, string> = {}): Record<string, string> => ({
      ...FILES,
      'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.put('/posts/:id', { name: 'posts.update' }, [PostController, 'update'])
  router.delete('/posts/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
}
`,
      'app/Http/Controllers/PostController.ts': controller(body),
      'app/Http/Controllers/BaseController.ts': base,
      'app/Unrelated.ts': 'export const unrelated = 1\n',
      ...extra,
    })
    const handlers = async (name: string, body: string, extra?: Record<string, string>) => {
      const records = await readSecurityRecords(await app(name, files(body, extra)))
      if ('unreadable' in records) throw new Error(records.unreadable)
      const of = (method: string) => records.routes.find((route) => route.method === method)!.handler
      return { update: of('PUT'), destroy: of('DELETE') }
    }
    const templated = "    const action = 'publish'\n    await this.authorize(`posts.${action}`, 'Post')"
    const gate = "    const gate = this.make('gate')\n    await gate.authorize('manage-posts')"

    // Compared as text: Bun's toMatchObject writes the asymmetric matchers into the object it reads.
    const text = (value: unknown): string => JSON.stringify(value)
    const before = await handlers('digest-a', templated)
    const [update, destroy] = [text(before.update), text(before.destroy)]
    expect(before.update).toMatchObject({ authorizes: [], unseen: expect.any(String) })
    expect(before.destroy).toMatchObject({ unread: expect.stringContaining('was not found'), digest: expect.any(String) })
    expect(text((await handlers('digest-b', templated.replace("'publish'", "'view'"))).update)).not.toBe(update)
    expect(text((await handlers('digest-d', templated, { 'app/Http/Controllers/BaseController.ts': base.replace("    await this.authorize('delete', 'Post')\n", '') })).destroy)).not.toBe(destroy)
    const gated = await handlers('digest-e', gate)
    const gatedText = text(gated.update)
    expect(gated.update).toMatchObject({ unseen: expect.any(String) })
    // The gate's arguments name no binding, so a file the body imports for something else is not reached.
    expect(text((await handlers('digest-c', gate, { 'app/Unrelated.ts': 'export const unrelated = 2\n' })).update)).toBe(gatedText)
    expect(text((await handlers('digest-f', "    const gate = this.make('gate')")).update)).not.toBe(gatedText)
  })
  test('follows a local an unnamed call passes, the class chain for this.<member>, and a dense graph in one walk', async () => {
    const validators = `import { z } from 'zod'

export const PostSchema = z.object({ title: z.string().min(1) })
export const AdminPostSchema = z.object({ title: z.string() })
`
    const controller = (body: string) => `import { z } from 'zod'
import { Controller } from '@guren/core'
import { PostSchema, AdminPostSchema } from '../Validators/PostValidator.js'
import { pages } from '../../Pages.js'
import { t0 } from '../../Dense.js'

export class PostController extends Controller {
  schema = z.object({ title: z.string().min(1) })
  isAdmin(): boolean {
    return pages.a > 0
  }

  async update(): Promise<Response> {
${body}
    return this.json({})
  }
}
`
    const dense = Array.from({ length: 40 }, (_, i) => `export function t${i}(): unknown {\n  return [${[i + 1, i + 2, i - 1].filter((n) => n >= 0 && n < 40).map((n) => `t${n}`).join(', ')}]\n}`).join('\n')
    const files = (body: string, extra: Record<string, string> = {}): Record<string, string> => ({
      ...FILES,
      'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.put('/posts/:id', { name: 'posts.update' }, [PostController, 'update'])
}
`,
      'app/Http/Controllers/PostController.ts': controller(body),
      'app/Http/Validators/PostValidator.ts': validators,
      'app/Pages.ts': 'export const pages = { a: 1 }\n',
      'app/Dense.ts': `${dense}\n`,
      ...extra,
    })
    const update = async (name: string, body: string, extra?: Record<string, string>): Promise<string> => {
      const records = await readSecurityRecords(await app(name, files(body, extra)))
      if ('unreadable' in records) throw new Error(records.unreadable)
      return JSON.stringify(records.routes.find((route) => route.method === 'PUT')!.handler)
    }
    const local = '    const schema = this.isAdmin() ? AdminPostSchema : PostSchema\n    await this.validateBody(schema)'
    const own = '    await this.validateBody(this.schema)'
    const loosened = { 'app/Http/Validators/PostValidator.ts': validators.replace('z.string().min(1)', 'z.string()') }
    const page = { 'app/Pages.ts': 'export const pages = { a: 2 }\n' }

    const localBefore = await update('local-a', local)
    expect(await update('local-b', local, loosened)).not.toBe(localBefore)
    const ownBefore = await update('own-a', own)
    expect(await update('own-b', own, page)).toBe(ownBefore)
    expect(await update('own-c', own, { 'app/Http/Controllers/PostController.ts': controller(own).replace('title: z.string().min(1)', 'title: z.string()') })).not.toBe(ownBefore)
    const started = Date.now()
    await update('dense', "    await this.authorize(String(t0), 'Post')")
    expect(Date.now() - started).toBeLessThan(20_000)
  })
  test('reads names from the syntax tree: a spread, a comment with an apostrophe, destructuring, a default import and a re-exported parent', async () => {
    const validators = `import { z } from 'zod'
import fallback from './Fallback.js'

const baseShape = { title: z.string().min(1) }
const { bodyRule } = { bodyRule: z.string().min(1) }

export const SpreadSchema = z.object({
  // the author's id is set by the server
  ...baseShape,
  body: bodyRule,
  note: fallback,
})
`
    const base = `import { Controller } from '@guren/core'

export class BaseController extends Controller {
  async destroy(): Promise<Response> {
    await this.authorize('delete', 'Post')
    return this.json({})
  }
}
`
    const files = (extra: Record<string, string> = {}): Record<string, string> => ({
      ...FILES,
      'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.put('/posts/:id', { name: 'posts.update' }, [PostController, 'update'])
  router.delete('/posts/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
}
`,
      'app/Http/Controllers/PostController.ts': `import { BaseController } from './Base/index.js'
import { SpreadSchema } from '../Validators/PostValidator.js'

export class PostController extends BaseController {
  async update(): Promise<Response> {
    await this.validateBody(SpreadSchema)
    return this.json({})
  }
}
`,
      'app/Http/Controllers/Base/index.ts': "export * from '../BaseController.js'\n",
      'app/Http/Controllers/BaseController.ts': base,
      'app/Http/Validators/PostValidator.ts': validators,
      'app/Http/Validators/Fallback.ts': "import { z } from 'zod'\n\nexport default z.string().min(1)\n",
      ...extra,
    })
    const read = async (name: string, extra?: Record<string, string>) => {
      const records = await readSecurityRecords(await app(name, files(extra)))
      if ('unreadable' in records) throw new Error(records.unreadable)
      const of = (method: string) => JSON.stringify(records.routes.find((route) => route.method === method)!.handler)
      return { update: of('PUT'), destroy: of('DELETE') }
    }
    const before = await read('tree-a')
    const loosen = (find: string, replace: string) => ({ 'app/Http/Validators/PostValidator.ts': validators.replace(find, replace) })

    expect((await read('tree-b', loosen('const baseShape = { title: z.string().min(1) }', 'const baseShape = { title: z.string() }'))).update).not.toBe(before.update)
    expect((await read('tree-c', loosen('bodyRule: z.string().min(1)', 'bodyRule: z.string()'))).update).not.toBe(before.update)
    expect((await read('tree-d', { 'app/Http/Validators/Fallback.ts': "import { z } from 'zod'\n\nexport default z.string()\n" })).update).not.toBe(before.update)
    expect((await read('tree-e', { 'app/Http/Controllers/BaseController.ts': base.replace("    await this.authorize('delete', 'Post')\n", '') })).destroy).not.toBe(before.destroy)
  })
})
