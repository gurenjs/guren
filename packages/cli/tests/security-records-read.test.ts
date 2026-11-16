import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { rm, symlink } from 'node:fs/promises'
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

describe('readSecurityRecords', () => {
  test('reads the chain, the contract and its export, and the action\'s calls of an introspected route', async () => {
    const dir = join(ROOT, 'app')
    await writeWorkspaceFiles(dir, FILES)
    await linkWorkspaceCore(dir)
    await symlink(WORKSPACE_ZOD, join(dir, 'node_modules', 'zod'), 'dir')

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
})
