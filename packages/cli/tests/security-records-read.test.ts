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
      action: 'PostController.update',
      middleware: [{ capabilities: { authentication: { mode: 'required' } } }],
      contracts: { body: { exports: ['app/Http/Validators/PostValidator.ts#PostSchema'], declarations: { 'app/Http/Validators/PostValidator.ts#PostSchema': expect.stringMatching(/^declaration:/) } } },
      handler: {
        authenticates: true,
        authorizes: [{ member: 'authorize', ability: 'update', subject: "'Post'" }],
        validates: [{ member: 'validateParams', schema: 'app/Http/Validators/PostValidator.ts#IdSchema', declaration: expect.stringMatching(/^declaration:/) }],
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

    const before = await handlers('digest-a', templated)
    expect(before.update).toMatchObject({ authorizes: [], unseen: expect.any(String) })
    expect(before.destroy).toMatchObject({ unread: expect.stringContaining('was not found'), digest: expect.any(String) })
    expect((await handlers('digest-b', templated.replace("'publish'", "'view'"))).update).not.toEqual(before.update)
    expect((await handlers('digest-c', templated, { 'app/Unrelated.ts': 'export const unrelated = 2\n' })).update).toEqual(before.update)
    expect((await handlers('digest-d', templated, { 'app/Http/Controllers/BaseController.ts': base.replace("    await this.authorize('delete', 'Post')\n", '') })).destroy).not.toEqual(before.destroy)
    const gated = await handlers('digest-e', gate)
    expect(gated.update).toMatchObject({ unseen: expect.any(String) })
    expect((await handlers('digest-f', "    const gate = this.make('gate')")).update).not.toEqual(gated.update)
  })
})
