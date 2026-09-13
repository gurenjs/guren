import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { generateEntityContext, renderEntityContextMarkdown } from '../src/entity-context'
import { createTempWorkspace, type TempWorkspace } from './helpers'

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content, 'utf8')
}

// The shape tutorial chapter 5 builds: auth controllers that are not named
// UserController and bind no User, so only their action bodies tie them to it.
async function writeAuthFixture(dir: string): Promise<void> {
  await put(dir, 'package.json', '{}')
  await put(
    dir,
    'db/schema.ts',
    `import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})
`,
  )
  await put(
    dir,
    'app/Models/User.ts',
    `import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {
}
`,
  )
  await put(
    dir,
    'app/Models/Post.ts',
    `import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {}
`,
  )
  await put(
    dir,
    'app/Http/Controllers/Auth/RegisterController.ts',
    `import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { User } from '../../../Models/User.js'
import { RegisterSchema } from '../../Validators/RegisterValidator.js'

export default class RegisterController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.Register, {})
  }

  async store(): Promise<Response> {
    const { name, email, password } = await this.validateBody(RegisterSchema)
    const user = await User.create({ name, email, password })

    await this.auth.login(user)
    return this.redirect('/')
  }
}
`,
  )
  await put(
    dir,
    'app/Http/Controllers/Auth/LoginController.ts',
    `import { Controller, ValidationException } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { LoginSchema } from '../../Validators/LoginValidator.js'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.Login, {})
  }

  async store(): Promise<Response> {
    const { email, password } = await this.validateBody(LoginSchema)
    const authenticated = await this.auth.attempt({ email, password })
    if (!authenticated) {
      throw ValidationException.withMessages({ message: 'Invalid credentials.' })
    }
    return this.redirect('/')
  }
}
`,
  )
  await put(
    dir,
    'app/Http/Controllers/ProfileController.ts',
    `import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import type { UserRecord } from '../../Models/User.js'
import { UserResource } from '../Resources/UserResource.js'

export default class ProfileController extends Controller {
  async show(): Promise<Response> {
    const user = await this.auth.userOrFail<UserRecord>()

    return this.inertia(pages.profile.Show, {
      user: new UserResource(user).toJSON(),
    })
  }
}
`,
  )
  await put(
    dir,
    'app/Http/Controllers/AccountController.ts',
    `import { Controller } from '@guren/core'
import { User as Account } from '@/app/Models/User'

export default class AccountController extends Controller {
  destroy = async () => {
    await Account.query().where('id', 1).delete()
    return this.redirect('/')
  }
}
`,
  )
  await put(
    dir,
    'app/Http/Controllers/PostController.ts',
    `import { Controller } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'

class User {
  static create(_: unknown) {}
}

interface PostPayload {
  author: UserRecord
}

export default class PostController extends Controller {
  async index(): Promise<Response> {
    // Unlike User.find(1), this local User is not the model.
    User.create({})
    const payload: PostPayload | null = null
    return this.json({ payload, label: 'User.create' })
  }
}
`,
  )
  await put(dir, 'app/Http/Controllers/GhostController.ts', 'export default class GhostController {\n  index( {\n')
  await put(dir, 'resources/js/pages/profile/Show.tsx', 'export default function Show() { return null }\n')
  await put(dir, 'resources/js/pages/auth/Login.tsx', 'export default function Login() { return null }\n')
  await put(
    dir,
    'routes/web.ts',
    `import type { Router } from '@guren/core'

class RegisterController { show() {} store() {} }
class LoginController { show() {} store() {} }
class ProfileController { show() {} }
class AccountController { destroy() {} }
class PostController { index() {} }
class GhostController { index() {} }
class AttachmentDeliveryController { show() {} }

export function registerWebRoutes(router: Router): void {
  router.get('/register', [RegisterController, 'show'] as any).name('register')
  router.post('/register', [RegisterController, 'store'] as any).name('register.store')
  router.get('/login', [LoginController, 'show'] as any).name('login')
  router.post('/login', [LoginController, 'store'] as any).name('login.store')
  router.get('/profile', [ProfileController, 'show'] as any).name('profile')
  router.delete('/account', [AccountController, 'destroy'] as any).name('account.destroy')
  router.get('/posts', [PostController, 'index'] as any).name('posts.index')
  router.get('/ghost', [GhostController, 'index'] as any).name('ghost')
  router.get('/attachments/:id', [AttachmentDeliveryController, 'show'] as any)
  router.get('/health', () => new Response('ok'))
}
`,
  )
}

describe('entity context (routes linked by action references)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-entity-route-links-')
    await writeAuthFixture(workspace.dir)
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('links routes whose action uses the model class or passes its record type to this.auth', async () => {
    const ctx = await generateEntityContext('User', { cwd: workspace.dir })

    expect(ctx.routes.map((route) => [route.name, route.linkedBy])).toEqual([
      ['register.store', 'reference'],
      ['profile', 'reference'],
      ['account.destroy', 'reference'],
    ])
  })

  it('does not link a same-named local class, a record type used as a field, or a comment', async () => {
    const ctx = await generateEntityContext('User', { cwd: workspace.dir })

    expect(ctx.routes.map((route) => route.name)).not.toContain('posts.index')
    expect(ctx.routes.map((route) => route.name)).not.toContain('login.store')
  })

  it('reports an app controller whose action body cannot be read, but not one with no source in the app', async () => {
    const ctx = await generateEntityContext('User', { cwd: workspace.dir })

    // AttachmentDeliveryController stands in for a controller a framework helper registers.
    expect(ctx.unverifiedRoutes).toEqual([
      {
        method: 'GET',
        path: '/ghost',
        name: 'ghost',
        action: 'GhostController.index',
        reason: 'app/Http/Controllers/GhostController.ts could not be parsed',
      },
    ])
  })

  it('lists the pages rendered by linked actions only', async () => {
    const ctx = await generateEntityContext('User', { cwd: workspace.dir })

    expect(ctx.pages.map((page) => page.id)).toEqual(['profile/Show'])
  })

  it('surfaces hidden in the model section of both the JSON and the markdown bundle', async () => {
    const ctx = await generateEntityContext('User', { cwd: workspace.dir })
    const md = renderEntityContextMarkdown(ctx)

    expect(ctx.model.hidden).toEqual(['passwordHash', 'rememberToken'])
    expect(ctx.model.fillable).toBeNull()
    expect(md).toContain('- Traits: Authenticatable')
    expect(md).toContain('- Hidden: passwordHash, rememberToken')
    expect(md).not.toContain('- Fillable:')
    expect(md).toContain('## Routes (3)')
    expect(md).toContain('| POST | /register | register.store | RegisterController.store |')
    expect(md).toContain('- profile/Show')
    expect(md).toContain('Not checked for references to User (1):')
    expect(md).toContain('- GET /ghost → GhostController.index: app/Http/Controllers/GhostController.ts could not be parsed')
  })

  it('links nothing by reference for an entity no other action names', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir })

    expect(ctx.routes.map((route) => [route.name, route.linkedBy])).toEqual([['posts.index', 'controller']])
    expect(ctx.pages).toEqual([])
  })
})
