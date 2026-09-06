# Chapter 5: Users and Passwords

Everything so far has been anonymous. This chapter gives the blog users: a table with a password hash, a model that knows how to hash, sessions and the CSRF protection that comes with them, and registration, login and logout built by hand. Then you specify a profile page with a test and hand it to the agent, and you see what `guren context User` gives an agent before it touches a model.

Guren can install all of this with one command. You are building it yourself, once, so that in chapter 6 you can read that command's output and know what every line is for.

**What you'll learn:**

- What turning on sessions changes: a cookie, a store, and CSRF protection on every mutating request
- How a password is stored (never the password) and where the hashing happens
- What `this.auth.attempt()`, `login()`, `logout()` and `userOrFail()` do, and what a guard is
- Why the tests you wrote in chapter 4 broke, and how a test primes a CSRF token
- How an entity bundle from `guren context User` differs from the whole-project map

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. The users table, for real

The scaffold shipped a `users` table with a name, an email and a timestamp. A user who can sign in needs two more things: a place for the password hash, and an email that cannot be shared by two accounts. Replace `db/schema.ts`:

```ts file=db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

The column is `passwordHash`, and its name is the point: the database never holds a password, only the output of a slow, salted hash of one. `rememberToken` is the "remember me" cookie's secret; it is nullable because most sessions do not use it.

```bash run
bun run db:make add_passwords_to_users
```

```bash run
bun run db:migrate
```

Open the new migration. SQLite cannot add a `NOT NULL` column to an existing table or change its constraints in place, so the generated SQL rebuilds the table: create the new shape, copy the rows across, drop the old one, rename. Your `users` table has no rows yet, so this is free; chapter 6 does the same dance on a table that has data.

## 2. The model that hashes

Create `app/Models/User.ts`:

```ts file=app/Models/User.ts
import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  // Derived from the plain `password`, so callers never set it directly
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  // Never serialized by Model.serialize() and stripped from auth.user()
  hidden: ['passwordHash', 'rememberToken'],
}) {
}
```

Three options, each doing one job:

- **`base: AuthenticatableModel`** is what makes this a user rather than a row. It adds a virtual `password` field: `User.create({ name, email, password: 'secret' })` hashes the password and stores the result in `passwordHash`. No controller in this chapter calls a hasher; the model owns that.
- **`optionalOnCreate` / `requireOnCreate`** adjust the create payload's type to match: you must pass `password`, you may not pass `passwordHash`.
- **`hidden`** keeps the hash and the remember token out of every serialization, including the user object the auth context hands to pages. In chapter 4 you were promised a resource layer would stop `passwordHash` reaching the browser; this is the second lock on the same door.

## 3. Sessions, and the provider that names the model

A session is how the server remembers who a request belongs to: a cookie holding an id, and a store holding what the id points to. Guren mounts session middleware, and CSRF protection with it, when `createApp` receives an `auth` option. The auth system also needs to know which model holds users and which columns to check. That is an app-local provider. Create `app/Providers/AuthProvider.ts`:

```ts file=app/Providers/AuthProvider.ts
import { ServiceProvider, shareInertiaProps, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext, AuthManager } from '@guren/core'
import { User } from '../Models/User.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }

  boot(): void {
    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}
```

`useModel` registers a **guard** named `web`: the thing that, given a request, answers "who is this?" by reading the session, and given credentials, answers "are these right?" by comparing a hash. `shareInertiaProps` adds `auth.user` to the props of every page, so any component can ask whether someone is signed in. It is `null` for a guest, and it never contains the hash because of `hidden`.

Now turn it on. Replace `src/app.ts`:

```ts file=src/app.ts
// Every zod schema built after this import parses through a compiled fast
// path. Keep it the first import so it runs before any module that defines
// schemas. It honors z.config({ jitless: true }) for CSP-restricted runtimes
// and never throws — unsupported schemas keep the regular parser. One caveat:
// on invalid input, refinements/transforms can run twice (fast path, then
// fallback), so keep .refine()/.transform() free of side effects.
import 'zod/compile'
import { createApp } from '@guren/core'
import { setInertiaDocument } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'
import { registerWebRoutes } from '../routes/web.js'

// Rendered into every server-rendered document. Replace public/favicon.svg
// with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
setInertiaDocument({
  head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
})

// The Host header is client-controlled, so production should answer only to the
// host this app is deployed as, which APP_URL carries.
//
// Read at module scope, where not every platform has populated process.env yet
// (the Cloudflare worker imports this module before wrangler `vars` land). A
// missing value therefore warns and leaves the check off, rather than throwing
// and stopping the app from booting at all. Emailed links do not depend on this
// — app/Auth/AppUrl.ts resolves those per request and fails closed there.
function hostAuthorization() {
  const exclude = ['/health']

  if (process.env.NODE_ENV !== 'production') {
    return { allowedHosts: ['localhost:*', '127.0.0.1:*'], exclude }
  }

  const appUrl = process.env.APP_URL?.trim()
  if (!appUrl) {
    console.warn('[app] APP_URL is not set — host authorization is disabled. Set it to the public base URL of this app.')
    return false
  }

  // `hostname:*` rather than the bare host: the hostname is the security
  // boundary, and a proxy may or may not include the default port in `Host`.
  return { allowedHosts: [`${new URL(appUrl).hostname}:*`], exclude }
}

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider, AuthProvider],
  // Sessions and CSRF protection: an in-memory session store by default,
  // which chapter 14 replaces with a database-backed one.
  auth: {},
  // Translations live in lang/<locale>/*.json. Add locales to `supported`
  // and the request locale is detected from ?locale=, a locale cookie, or
  // Accept-Language. `guren codegen` types the keys for t()/useTranslation().
  i18n: { supported: ['en'] },
  hostAuthorization: hostAuthorization(),
})

export default app
```

Two lines changed: `AuthProvider` in `providers`, and `auth: {}`. Run the tests:

```bash run expect-fail
bun test
```

## 4. What sessions broke, and why that is right

Every test that submitted a form is red with a 403: "CSRF token mismatch". Nothing about posts changed. What changed is that the app now has sessions, and an app with sessions has to defend them.

A cross-site request forgery is another site's page making your browser submit a form to this app. The browser attaches your session cookie; the app cannot tell the request from one you meant. The defence is a token the app puts in a cookie and expects back in a header or a form field on every `POST`, `PUT`, `PATCH` and `DELETE`. Another site cannot read your cookies, so it cannot produce the token. Inertia's forms do this automatically: `form.post()` copies the `XSRF-TOKEN` cookie into the `X-XSRF-TOKEN` header, which is why the browser never noticed.

Your tests noticed, because they are not a browser. `TestApp` has `withCsrf()` for exactly this: it makes one `GET`, keeps the cookies and the token it was given, and returns a client that sends them with every request. Replace `tests/PostController.test.ts`; the only change is that the mutating requests go through `csrf`:

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'

describe('PostController', () => {
  let http: TestApp
  let csrf: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
    csrf = await http.withCsrf()
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('lists posts, newest first', async () => {
    await Post.create({ title: 'First post', body: 'Hello' })
    await Post.create({ title: 'Second post', body: 'Again' })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
  })

  it('paginates ten posts per page', async () => {
    for (let i = 1; i <= 11; i++) {
      await Post.create({ title: `Post ${String(i).padStart(2, '0')}`, body: `Body number ${i}` })
    }

    const firstPage = await http.get('/posts').assertOk()
    await firstPage.assertBodyContains('Post 11')
    await firstPage.assertBodyContains('Post 02')
    expect(await firstPage.text()).not.toContain('Post 01')

    const secondPage = await http.get('/posts?page=2').assertOk()
    await secondPage.assertBodyContains('Post 01')
    expect(await secondPage.text()).not.toContain('Post 02')
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('serves the form for a new post', async () => {
    await http.get('/posts/create').assertOk()
  })

  it('stores a post and redirects to it', async () => {
    await csrf.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
  })

  it('rejects an empty post with a message per field', async () => {
    await csrf
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })

  it('serves the edit form with the post in it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    const response = await http.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('updates a post and redirects to it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await csrf.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await csrf
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post and redirects to the list', async () => {
    const post = await Post.create({ title: 'Doomed', body: 'Gone soon' })

    await csrf.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })
})
```

```bash run
bun test
```

Green again. Commit this checkpoint; it is a real change on its own:

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the user model, sessions, and CSRF protection"
```

## 5. Specify registration and login

Two controllers, specified before they exist. Registration:

```ts file=tests/RegisterController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('RegisterController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('serves the registration form', async () => {
    await http.get('/register').assertOk()
  })

  it('creates the user, stores a hash rather than the password, and redirects', async () => {
    const csrf = await http.withCsrf('/register')
    await csrf
      .post('/register', {
        name: 'Ada',
        email: 'ada@example.com',
        password: 'correct horse battery',
        passwordConfirmation: 'correct horse battery',
      })
      .assertRedirect('/')

    const user = await User.where('email', 'ada@example.com').first()
    expect(user).not.toBeNull()
    expect(user?.passwordHash).not.toBe('correct horse battery')
    expect(user?.passwordHash.length).toBeGreaterThan(20)
  })

  it('rejects a short password with a message', async () => {
    const csrf = await http.withCsrf('/register')
    await csrf
      .post('/register', { name: 'Ada', email: 'ada@example.com', password: 'short', passwordConfirmation: 'short' })
      .assertStatus(422)
      .assertJsonPath('errors.password.0', 'Password must be at least 8 characters.')
  })
})
```

And login and logout:

```ts file=tests/LoginController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('LoginController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
  })

  it('serves the login form', async () => {
    await http.get('/login').assertOk()
  })

  it('signs in with the right password and redirects', async () => {
    const csrf = await http.withCsrf('/login')
    await csrf.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
  })

  it('rejects the wrong password with a message', async () => {
    const csrf = await http.withCsrf('/login')
    await csrf
      .post('/login', { email: 'ada@example.com', password: 'wrong' })
      .assertStatus(422)
      .assertJsonPath('errors.message.0', 'Invalid credentials.')
  })

  it('signs out and redirects home', async () => {
    const user = await User.where('email', 'ada@example.com').first()
    const csrf = await http.actingAs(user).withCsrf()
    await csrf.post('/logout').assertRedirect('/')
  })
})
```

Notice what the registration test checks: not that the password was stored, but that it was *not* stored, and that something long was stored instead. That is the one property of this whole chapter you would most want a test to hold. `actingAs(user)` in the last test stands in for a signed-in session; you will use it a great deal in chapters 6 and 7.

```bash run expect-fail
bun test
```

Seven red, all 404s.

## 6. Registration and login, by hand

The validators first. The email is lowercased before it is checked and stored, so `Ada@Example.com` and `ada@example.com` are one account:

```ts file=app/Http/Validators/RegisterValidator.ts
import { z } from 'zod'

export const RegisterSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required.').max(120, 'Name must be 120 characters or fewer.'),
    email: z.string().trim().min(1, 'Email is required.').toLowerCase().pipe(z.email('The email address is badly formatted.')),
    password: z.string().min(8, 'Password must be at least 8 characters.'),
    passwordConfirmation: z.string().min(1, 'Please confirm your password.'),
  })
  .refine((data) => data.password === data.passwordConfirmation, {
    message: 'Passwords do not match.',
    path: ['passwordConfirmation'],
  })

export type RegisterInput = z.infer<typeof RegisterSchema>
```

```ts file=app/Http/Validators/LoginValidator.ts
import { z } from 'zod'

export const LoginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required.').toLowerCase().pipe(z.email('The email address is badly formatted.')),
  password: z.string().min(1, 'Password is required.'),
})

export type LoginInput = z.infer<typeof LoginSchema>
```

The registration controller. The interesting line is the one that is missing: there is no hashing here, because the model does it.

```ts file=app/Http/Controllers/Auth/RegisterController.ts
import { Controller } from '@guren/core'
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
```

`this.auth.login(user)` writes the user's id into the session and rotates the session id, so a session that existed before sign-in cannot be reused after it. From this request on, `this.auth.user()` on any request with that cookie returns Ada.

The login controller:

```ts file=app/Http/Controllers/Auth/LoginController.ts
import { Controller, ValidationException } from '@guren/core'
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

  async destroy(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()
    return this.redirect('/')
  }
}
```

`attempt()` looks the user up by email, verifies the password against the stored hash, and on success does what `login()` does. On failure it takes the same time whether the email existed or not, so an attacker cannot tell the two apart by the clock. The failure is reported as a validation error with one message rather than "wrong password" or "no such user", for the same reason. `logout()` forgets the user; `invalidate()` throws the session away entirely.

Two pages. They use the `errors` prop Guren fills in when a form is rejected, which is what carries "Invalid credentials.":

```tsx file=resources/js/pages/auth/Register.tsx
import { Head, Link, useForm } from '@inertiajs/react'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'name' | 'email' | 'password' | 'passwordConfirmation'>
}

interface RegisterForm {
  name: string
  email: string
  password: string
  passwordConfirmation: string
}

const inputClass =
  'mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function Register({ errors = {} }: Props) {
  const form = useForm<RegisterForm>({ name: '', email: '', password: '', passwordConfirmation: '' })

  return (
    <>
      <Head title="Sign up" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-md px-6 py-12">
          <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
            <h1 className="text-2xl font-bold text-g-heading">Create an account</h1>
            {errors.message && <p className="mt-4 text-sm text-g-danger">{errors.message}</p>}
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                form.post('/register')
              }}
            >
              <label className="block text-sm">
                Name
                <input type="text" value={form.data.name} onChange={(event) => form.setData('name', event.target.value)} className={inputClass} />
                {errors.name && <p className="mt-1 text-sm text-g-danger">{errors.name}</p>}
              </label>
              <label className="block text-sm">
                Email
                <input type="email" value={form.data.email} onChange={(event) => form.setData('email', event.target.value)} className={inputClass} />
                {errors.email && <p className="mt-1 text-sm text-g-danger">{errors.email}</p>}
              </label>
              <label className="block text-sm">
                Password
                <input type="password" value={form.data.password} onChange={(event) => form.setData('password', event.target.value)} className={inputClass} />
                {errors.password && <p className="mt-1 text-sm text-g-danger">{errors.password}</p>}
              </label>
              <label className="block text-sm">
                Confirm password
                <input type="password" value={form.data.passwordConfirmation} onChange={(event) => form.setData('passwordConfirmation', event.target.value)} className={inputClass} />
                {errors.passwordConfirmation && <p className="mt-1 text-sm text-g-danger">{errors.passwordConfirmation}</p>}
              </label>
              <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                Sign up
              </button>
            </form>
            <p className="mt-6 text-sm text-g-text-2">
              Already have an account?{' '}
              <Link href="/login" className="text-g-accent-text hover:underline">Sign in</Link>
            </p>
          </section>
        </div>
      </main>
    </>
  )
}
```

```tsx file=resources/js/pages/auth/Login.tsx
import { Head, Link, useForm } from '@inertiajs/react'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'email' | 'password'>
}

interface LoginForm {
  email: string
  password: string
}

const inputClass =
  'mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function Login({ errors = {} }: Props) {
  const form = useForm<LoginForm>({ email: '', password: '' })

  return (
    <>
      <Head title="Sign in" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-md px-6 py-12">
          <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
            <h1 className="text-2xl font-bold text-g-heading">Sign in</h1>
            {errors.message && <p className="mt-4 text-sm text-g-danger">{errors.message}</p>}
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                form.post('/login')
              }}
            >
              <label className="block text-sm">
                Email
                <input type="email" value={form.data.email} onChange={(event) => form.setData('email', event.target.value)} className={inputClass} />
                {errors.email && <p className="mt-1 text-sm text-g-danger">{errors.email}</p>}
              </label>
              <label className="block text-sm">
                Password
                <input type="password" value={form.data.password} onChange={(event) => form.setData('password', event.target.value)} className={inputClass} />
                {errors.password && <p className="mt-1 text-sm text-g-danger">{errors.password}</p>}
              </label>
              <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                Sign in
              </button>
            </form>
            <p className="mt-6 text-sm text-g-text-2">
              No account yet?{' '}
              <Link href="/register" className="text-g-accent-text hover:underline">Sign up</Link>
            </p>
          </section>
        </div>
      </main>
    </>
  )
}
```

And the routes. `/logout` is a `POST` on purpose: a `GET` that changes state is a link someone can make you click.

```ts file=routes/web.ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.get('/register', [RegisterController, 'show']).name('register')
  router.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
  router.get('/login', [LoginController, 'show']).name('login')
  router.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  router.post('/logout', [LoginController, 'destroy']).name('logout')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    posts.put('/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    posts.delete('/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

Green. **Checkpoint:** open [http://localhost:3333/register](http://localhost:3333/register), create an account, and you land on the home page signed in, although nothing on it says so yet. Try `/login` with the wrong password: "Invalid credentials." Notice the two things you did not build: the session cookie, and the CSRF token the form sent. Both came with `auth: {}`.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add registration, login, and logout"
```

## 7. Specify the profile page

Something for a signed-in user to see, and a way out. The specification:

```ts file=tests/ProfileController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('ProfileController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('shows the signed-in user their name and email', async () => {
    const user = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })

    const response = await http.actingAs(user).get('/profile').assertOk()
    await response.assertBodyContains('ada@example.com')
  })

  it('answers 401 to a guest', async () => {
    await http.get('/profile').assertUnauthorized()
  })
})
```

```bash run expect-fail
bun test
```

Two red. The second test pins a decision: a guest asking for `/profile` gets a 401, not a redirect. Chapter 6 turns that into a redirect to the login page for the whole protected area; for one page, the controller can refuse on its own.

## 8. Delegate it

Ask your agent:

> Add a `/profile` page named `profile` for the signed-in user. `ProfileController.show` gets the user with `this.auth.userOrFail()`, which answers 401 to a guest, and sends the name and email to `resources/js/pages/profile/Show.tsx` through a `UserResource` (id, name, email; never the password hash). The page shows both and has a "Log out" button that posts to `/logout` through an Inertia `Link` with `method="post"`. `tests/ProfileController.test.ts` describes it; make it pass.

This chapter's harness lever is **`guren context User`**. Chapter 1 showed you the whole-project map an agent gets at session start. Before an agent touches one entity, it can ask for that entity's bundle instead:

```bash run
bunx guren context User
```

Model, columns, every route and page that touches it, and the docs that govern it, in one screen. The scaffold's rules tell the agent to run this before entity work, so watch for it in the transcript. An agent that has read the bundle knows `passwordHash` is hidden and that `User` is an `AuthenticatableModel` before it writes the resource.

**No agent handy?** Four files:

```ts file=app/Http/Resources/UserResource.ts fallback
import { Resource } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'

export interface UserResourceData extends Record<string, unknown> {
  id: number
  name: string
  email: string
}

export class UserResource extends Resource<UserRecord, UserResourceData> {
  toArray(): UserResourceData {
    return {
      id: this.resource.id,
      name: this.resource.name,
      email: this.resource.email,
    }
  }
}
```

```ts file=app/Http/Controllers/ProfileController.ts fallback
import { Controller } from '@guren/core'
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
```

```tsx file=resources/js/pages/profile/Show.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { UserResourceData } from '@/app/Http/Resources/UserResource'

interface Props {
  user: UserResourceData
}

export default function ProfileShow({ user }: Props) {
  return (
    <>
      <Head title="Your profile" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="text-3xl font-bold text-g-heading">{user.name}</h1>
          <p className="text-g-text-2">{user.email}</p>
          <Link
            href="/logout"
            method="post"
            as="button"
            className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted"
          >
            Log out
          </Link>
        </div>
      </main>
    </>
  )
}
```

```ts file=routes/web.ts fallback
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.get('/register', [RegisterController, 'show']).name('register')
  router.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
  router.get('/login', [LoginController, 'show']).name('login')
  router.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  router.post('/logout', [LoginController, 'destroy']).name('logout')
  router.get('/profile', [ProfileController, 'show']).name('profile')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    posts.put('/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    posts.delete('/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric:

- The controller uses `this.auth.userOrFail()`, not `this.auth.user()` with a manual null check. `guren audit` recognises the former as an authentication check; it does not recognise the latter.
- The page receives a `UserResource`, and the resource has no `passwordHash`. Two layers already hide it; the rubric is that the agent did not reach past them.
- "Log out" is a `POST`, sent through an Inertia `Link` so the CSRF token travels with it. A plain `<form method="post">` would be refused with a 403.
- Both tests are green, and every earlier test still is.

**Checkpoint:** while signed in, open [http://localhost:3333/profile](http://localhost:3333/profile), then log out. Reload `/profile`: a 401.

```bash run
bunx guren gate
```

```bash run
bunx guren audit
```

The audit is quieter than it was. `POST /register`, `/login` and `/logout` are recognised as guest flows and not expected to require authentication. The three warnings on the post routes remain, and chapter 6 clears them.

```bash run
git add -A
git commit -m "feat: add the profile page"
```

## Where you are

- A `users` table with a hash and a unique email, migrated with a table rebuild.
- A model that hashes on create and hides the hash on the way out.
- Sessions with an in-memory store, CSRF protection on every mutating request, and tests that know how to prime a token.
- Registration, login and logout built by hand, with the tests that pin the one property that matters.
- A profile page, specified by you and built by the agent.

## Common trip-ups

- **Every form test fails with 403 after adding `auth: {}`.** That is section 4: mutating requests need a CSRF token now. Prime one with `withCsrf()` and send through the client it returns.
- **`withCsrf()` throws "did not set an XSRF-TOKEN cookie".** `auth` is not on `createApp`, or the priming path is not served by the app. Pass a path that returns a page.
- **Registering the same email twice gives a 500.** The unique constraint is doing its job and nothing above it is checking first. Chapter 6 adds the check; until then it is a database error, which is still better than two accounts.
- **`this.auth` throws "requires the auth middleware".** `AuthProvider` is not in `providers`, or `auth: {}` is missing. Both are needed: one mounts the session, the other names the model.
- **`actingAs()` in a login test always succeeds.** It replaces the whole auth context, including `attempt()`, with stubs. Use it to *be* a user, never to test signing in.

## Next

[Chapter 6: Protecting Routes](./06-protecting-routes.md) puts the post mutations behind a login wall with `requireAuthenticated`, gives every post an author with a migration that survives real data, and compares what you built with what `bunx guren add auth` generates.
