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
  test('follows a mixin parent and a same-file enum, and adds no class chain for a local that reads nothing of this', async () => {
    const mixin = (guard: string) => `import { Controller } from '@guren/core'

export function WithCrud<T extends new (...args: any[]) => Controller>(Root: T) {
  return class extends Root {
    async destroy(): Promise<Response> {
${guard}      return this.json({})
    }
  }
}
`
    const controller = (other: string) => `import { z } from 'zod'
import { Controller } from '@guren/core'
import { WithCrud } from './Mixin.js'

enum Role { Admin = 'admin' }
const RoleSchema = z.object({ role: z.enum(Role) })

export class PostController extends WithCrud(Controller) {
  async other(): Promise<Response> {
    ${other}
  }

  async update(): Promise<Response> {
    await this.validateBody(RoleSchema)
    const post = { id: 1 }
    await this.authorize(String(post.id), post)
    return this.json({})
  }
}
`
    const guard = "      await this.authorize('delete', 'Post')\n"
    const files = (extra: Record<string, string> = {}): Record<string, string> => ({
      ...FILES,
      'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.put('/posts/:id', { name: 'posts.update' }, [PostController, 'update'])
  router.delete('/posts/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
}
`,
      'app/Http/Controllers/Mixin.ts': mixin(guard),
      'app/Http/Controllers/PostController.ts': controller('return this.json({})'),
      ...extra,
    })
    const read = async (name: string, extra?: Record<string, string>) => {
      const records = await readSecurityRecords(await app(name, files(extra)))
      if ('unreadable' in records) throw new Error(records.unreadable)
      const of = (method: string) => JSON.stringify(records.routes.find((route) => route.method === method)!.handler)
      return { update: of('PUT'), destroy: of('DELETE') }
    }
    const before = await read('mixin-a')

    expect((await read('mixin-b', { 'app/Http/Controllers/Mixin.ts': mixin('') })).destroy).not.toBe(before.destroy)
    expect((await read('mixin-c', { 'app/Http/Controllers/PostController.ts': controller('return this.json({})').replace("Admin = 'admin'", "Admin = 'admin', Guest = 'guest'") })).update).not.toBe(before.update)
    // `post` is a local, so the body is the scope, but it reads nothing of `this`: another action's edit does not reach it.
    expect((await read('mixin-d', { 'app/Http/Controllers/PostController.ts': controller('return this.json({ edited: true })') })).update).toBe(before.update)
  })

  test("resolves an authorize() subject's class to its file and export, and marks only a call every statement before falls through to", async () => {
    const withBody = (body: string, models = 'Models'): Record<string, string> => ({
      ...FILES,
      'app/Models/Post.ts': 'export class Post {}\n',
      'app/Other/Post.ts': 'export class Post {}\n',
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { Post } from '../../${models}/Post.js'

export class PostController extends Controller {
  async update(): Promise<Response> {
${body}
    return this.json({})
  }
}
`,
    })
    const read = async (name: string, files: Record<string, string>) => {
      const records = await readSecurityRecords(await app(name, files))
      if ('unreadable' in records) throw new Error(records.unreadable)
      return records.routes.find((route) => route.path === '/posts/:id')!.handler
    }
    const asked = "    const post = { id: 1 }\n    await this.authorize('update', [Post, post])"
    const call = { member: 'authorize', ability: 'update', subject: '[Post, post]', classes: ['app/Models/Post.ts#Post'] }

    expect(await read('subject-plain', withBody(asked))).toMatchObject({ authorizes: [{ ...call, unconditional: true }] })
    expect(await read('subject-other', withBody(asked, 'Other'))).toMatchObject({ authorizes: [{ ...call, classes: ['app/Other/Post.ts#Post'], unconditional: true }] })
    for (const [name, body] of [
      ['subject-if', "    const post = { id: 1 }\n    if (post.id) await this.authorize('update', [Post, post])"],
      ['subject-return', "    const post = { id: 1 }\n    if (!post.id) return this.json({})\n    await this.authorize('update', [Post, post])"],
      ['subject-try', "    const post = { id: 1 }\n    try { await this.authorize('update', [Post, post]) } catch {}"],
      ['subject-void', "    const post = { id: 1 }\n    void this.authorize('update', [Post, post])"],
      ['subject-helper', "    const post = { id: 1 }\n    const check = async () => { await this.authorize('update', [Post, post]) }\n    await check()"],
    ] as const) {
      const handler = await read(name, withBody(body))
      // Not unconditional, so how it is reached is recorded: a further move is another call.
      expect(handler).toMatchObject({ authorizes: [{ ...call, reach: expect.any(String) }] })
      expect('authorizes' in handler && handler.authorizes[0]).not.toHaveProperty('unconditional')
    }
    // A local of the action naming the imported class hides which class it is: the body is digested instead.
    const shadowed = await read('subject-shadow', withBody("    const Post = class {}\n    const post = { id: 1 }\n    await this.authorize('update', [Post, post])"))
    expect(shadowed).toMatchObject({ authorizes: [{ member: 'authorize', ability: 'update', subject: '[Post, post]', unconditional: true }], unseen: expect.any(String) })
    expect('authorizes' in shadowed && shadowed.authorizes[0]).not.toHaveProperty('classes')
  })

  test("follows a subject's class to the module declaring it, digests an alias, and hides it behind a parameter or a local", async () => {
    const withController = (imports: string, params: string, body: string, extra: Record<string, string> = {}): Record<string, string> => ({
      ...FILES,
      'app/Models/Post.ts': 'export class Post {}\n',
      'app/Models/Map.ts': 'export class Map {}\n',
      'app/Other/Post.ts': 'export class Post {}\n',
      'app/Other/Draft.ts': 'export class Draft {}\n',
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
${imports}

export class PostController extends Controller {
  async update(${params}): Promise<Response> {
    const post = { id: 1 }
${body}
    return this.json({})
  }
}
`,
      ...extra,
    })
    const read = async (name: string, files: Record<string, string>) => {
      const records = await readSecurityRecords(await app(name, files))
      if ('unreadable' in records) throw new Error(records.unreadable)
      return records.routes.find((route) => route.path === '/posts/:id')!.handler
    }
    const asked = "    await this.authorize('update', [Post, post])"
    const barrel = (target: string) => withController("import { Post } from '../../Models/index.js'", '', asked, { 'app/Models/index.ts': `export { Post } from '${target}'\n` })

    expect(await read('barrel-model', barrel('./Post.js'))).toMatchObject({ authorizes: [{ classes: ['app/Models/Post.ts#Post'] }] })
    expect(await read('barrel-other', barrel('../Other/Post.js'))).toMatchObject({ authorizes: [{ classes: ['app/Other/Post.ts#Post'] }] })
    const alias = async (name: string, model: string) => read(name, withController(`import { ${model} } from '../../${model === 'Post' ? 'Models' : 'Other'}/${model}.js'\nconst Subject = ${model}`, '', "    await this.authorize('update', [Subject, post])"))
    const [post, draft] = [await alias('alias-post', 'Post'), await alias('alias-draft', 'Draft')]
    expect(post).toMatchObject({ authorizes: [{ classes: [expect.stringMatching(/^app\/Http\/Controllers\/PostController\.ts#Subject:/)] }] })
    expect(JSON.stringify(post)).not.toBe(JSON.stringify(draft))
    // A model named after a global is read as the file binds it.
    expect(await read('global-name', withController("import { Map } from '../../Models/Map.js'", '', "    await this.authorize('update', [Map, post])"))).toMatchObject({ authorizes: [{ classes: ['app/Models/Map.ts#Map'] }] })
    // A parameter, or a local in the class position, is what the router or the body passes: the body is digested.
    expect(await read('param-shadow', withController("import { Post } from '../../Models/Post.js'", '_c: unknown, Post: unknown', asked))).toMatchObject({ unseen: expect.any(String) })
    expect(await read('local-class', withController("import { Post } from '../../Models/Post.js'", '', "    const klass = Post\n    await this.authorize('update', [klass, post])"))).toMatchObject({ unseen: expect.any(String) })
    expect(await read('wrapped-class', withController("import { Post } from '../../Models/Post.js'", '', "    const klass = Post\n    await this.authorize('update', [klass!, post])"))).toMatchObject({ unseen: expect.any(String) })
    // `ns.Post` is the member as the namespace's module exports it, through its barrel.
    const namespaced = (target: string) => withController("import * as M from '../../Models/index.js'", '', "    await this.authorize('update', [M.Post, post])", { 'app/Models/index.ts': `export { Post } from '${target}'\n` })
    expect(await read('namespace-model', namespaced('./Post.js'))).toMatchObject({ authorizes: [{ classes: ['app/Models/Post.ts#Post'] }] })
    expect(await read('namespace-other', namespaced('../Other/Post.js'))).toMatchObject({ authorizes: [{ classes: ['app/Other/Post.ts#Post'] }] })
    // A namespace the reader does not follow keeps its specifier; a hop that ends in a file without the class is digested.
    expect(await read('namespace-package', withController("import * as M from 'zod'", '', "    await this.authorize('update', [M.ZodString, post])"))).toMatchObject({ authorizes: [{ classes: ['package:zod#ZodString'] }] })
    const starAs = withController("import { Models } from '../../Models/barrel.js'", '', "    await this.authorize('update', [Models.Post, post])", { 'app/Models/barrel.ts': "export * as Models from './index.js'\n", 'app/Models/index.ts': "export { Post } from './Post.js'\n" })
    expect(await read('namespace-star-as', starAs)).toMatchObject({ unseen: expect.any(String) })
  })

  test('digests the whole action for a call that is not unconditional, so a later statement acting on it counts', async () => {
    const helper = (call: string): Record<string, string> => ({
      ...FILES,
      'app/Models/Post.ts': 'export class Post {}\n',
      'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { Post } from '../../Models/Post.js'

export class PostController extends Controller {
  async update(): Promise<Response> {
    const post = { id: 1 }
    const check = async () => { await this.authorize('update', [Post, post]) }
    ${call}
    return this.json({})
  }
}
`,
    })
    const read = async (name: string, files: Record<string, string>) => {
      const records = await readSecurityRecords(await app(name, files))
      if ('unreadable' in records) throw new Error(records.unreadable)
      const handler = records.routes.find((route) => route.path === '/posts/:id')!.handler
      return 'authorizes' in handler ? handler.authorizes[0]?.reach : undefined
    }
    const called = await read('reach-called', helper('await check()'))

    expect(called).toEqual(expect.any(String))
    expect(await read('reach-dropped', helper('void 0'))).not.toBe(called)
  })
})
