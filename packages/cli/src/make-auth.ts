import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { writeFileSafe, type WriterOptions } from './utils'

function timestamp(): string {
  const now = new Date()
  const pad = (value: number, size = 2) => value.toString().padStart(size, '0')
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('')
}

const loginControllerTemplate = `import { Controller, parseRequestPayload, formatValidationErrors } from '@guren/core'
import { LoginSchema } from '@/Http/Validators/LoginValidator'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    const email = this.request.query('email') ?? ''
    return this.inertia('auth/Login', { email }, { url: this.request.path, title: 'Login' })
  }

  async store(): Promise<Response> {
    const payload = await parseRequestPayload(this.ctx)
    const result = LoginSchema.safeParse(payload)

    if (!result.success) {
      return this.json({ errors: formatValidationErrors(result.error) }, { status: 422 })
    }

    const { email, password, remember } = result.data

    this.auth.session()?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      return this.json({ errors: { message: 'Invalid credentials.' } }, { status: 422 })
    }

    return this.redirect('/dashboard')
  }

  async destroy(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()
    return this.redirect('/')
  }
}
`

const dashboardControllerTemplate = `import { Controller } from '@guren/core'

export default class DashboardController extends Controller {
  async index(): Promise<Response> {
    const user = await this.auth.user()
    return this.inertia('dashboard/Index', { user }, { url: this.request.path, title: 'Dashboard' })
  }
}
`

const userModelTemplate = `import { AuthenticatableModel } from '@guren/core'
import { users } from '../../db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
}
`

const authProviderTemplate = `import type { ApplicationContext, Provider } from '@guren/core'
import { ModelUserProvider, ScryptHasher } from '@guren/core'
import { User } from '../Models/User.js'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
      hasher: new ScryptHasher(),
    }))
  }
}
`

const loginValidatorTemplate = `import { z } from 'zod'

export const LoginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required.' })
    .trim()
    .min(1, 'Email is required.')
    .email('The email address is badly formatted.'),
  password: z
    .string({ required_error: 'Password is required.' })
    .min(1, 'Password is required.'),
  remember: z
    .union([
      z.boolean(),
      z
        .string()
        .transform((value) => ['true', 'on', '1'].includes(value.toLowerCase())),
    ])
    .optional()
    .transform((value) => Boolean(value))
    .default(false),
})

export type LoginInput = z.infer<typeof LoginSchema>
`

const layoutTemplate = `import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'

export default function Layout({ children }: PropsWithChildren) {
  const { props } = usePage()
  const user = props.auth?.user as { name?: string } | undefined

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold text-emerald-300">
            Guren
          </Link>
          <nav className="flex items-center gap-4 text-sm text-slate-300">
            <Link href="/" className="transition hover:text-emerald-200">
              Home
            </Link>
            <Link href="/dashboard" className="transition hover:text-emerald-200">
              Dashboard
            </Link>
            {user ? (
              <form method="post" action="/logout">
                <button
                  type="submit"
                  className="rounded border border-emerald-500 px-3 py-1 text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950"
                >
                  Log out
                </button>
              </form>
            ) : (
              <Link
                href="/login"
                className="rounded border border-emerald-500 px-3 py-1 text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12">
        {children}
      </main>
    </div>
  )
}
`

const loginViewTemplate = `import { Head, Link, usePage } from '@inertiajs/react'
import { useId, useState } from 'react'
import Layout from '../../components/Layout.js'

interface LoginErrors {
  email?: string
  password?: string
  message?: string
}

export default function Login() {
  const page = usePage<{ email?: string; errors?: LoginErrors }>()
  const [email, setEmail] = useState(page.props.email ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const errors = page.props.errors ?? {}

  const emailId = useId()
  const passwordId = useId()

  return (
    <Layout>
      <Head title="Sign in" />
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Sign in</h1>
        <p className="mt-2 text-sm text-slate-400">
          Use your account credentials to continue.
        </p>

        {errors.message && (
          <p className="mt-4 rounded border border-rose-500/60 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            {errors.message}
          </p>
        )}

        <form method="post" action="/login" className="mt-6 space-y-4">
          <div>
            <label htmlFor={emailId} className="block text-sm font-medium text-slate-200">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.email && <p className="mt-1 text-sm text-rose-300">{errors.email}</p>}
          </div>

          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-slate-200">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              name="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.password && <p className="mt-1 text-sm text-rose-300">{errors.password}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              name="remember"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-emerald-400 focus:ring-emerald-400"
            />
            Remember me
          </label>

          <button
            type="submit"
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
          >
            Sign in
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          Forgot your password? Contact your administrator.
        </p>
      </section>
    </Layout>
  )
}
`

const dashboardViewTemplate = `import Layout from '../../components/Layout.js'

interface DashboardProps {
  user?: {
    id: number
    name: string
    email: string
  } | null
}

export default function Dashboard({ user }: DashboardProps) {
  return (
    <Layout>
      <section className="space-y-6">
        <header>
          <h1 className="text-3xl font-semibold text-emerald-300">Dashboard</h1>
          <p className="mt-2 text-sm text-slate-400">This page is protected by the auth middleware.</p>
        </header>

        {user ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-6 shadow-lg shadow-emerald-500/10">
            <h2 className="text-xl font-medium text-slate-100">Signed in as {user.name}</h2>
            <p className="mt-2 text-sm text-slate-300">Email: {user.email}</p>
          </div>
        ) : (
          <div className="rounded border border-rose-500/60 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            You are not signed in.
          </div>
        )}
      </section>
    </Layout>
  )
}
`

const routesTemplate = `import { Route, requireAuthenticated, requireGuest } from '@guren/core'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'

Route.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' }))

Route.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
`

const seederTemplate = `import { defineSeeder } from '@guren/orm'
import { ScryptHasher } from '@guren/core'
import { users } from '../schema.js'

export default defineSeeder(async ({ db }) => {
  const hasher = new ScryptHasher()
  const passwordHash = await hasher.hash('secret')

  await db
    .insert(users)
    .values([
      {
        name: 'Demo User',
        email: 'demo@example.com',
        passwordHash,
      },
    ])
    .onConflictDoNothing({ target: users.email })
})
`

const migrationTemplate = `CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  remember_token TEXT,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
`

async function updateSchema(): Promise<void> {
  const schemaPath = resolve(process.cwd(), 'db/schema.ts')
  let content: string

  try {
    content = await readFile(schemaPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }

    throw error
  }

  if (content.includes('passwordHash')) {
    return
  }

  const updated = `import { pgTable, serial, text, timestamp } from '@guren/orm/drizzle'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: false }).defaultNow().notNull(),
})
`

  await writeFile(schemaPath, updated, 'utf8')
  consola.info('Updated db/schema.ts with authentication columns.')
}

export async function makeAuth(options: WriterOptions = {}): Promise<string[]> {
  const created: string[] = []

  created.push(await writeFileSafe('app/Http/Controllers/Auth/LoginController.ts', loginControllerTemplate, options))
  created.push(await writeFileSafe('app/Http/Controllers/DashboardController.ts', dashboardControllerTemplate, options))
  created.push(await writeFileSafe('app/Models/User.ts', userModelTemplate, options))
  created.push(await writeFileSafe('app/Providers/AuthProvider.ts', authProviderTemplate, options))
  created.push(await writeFileSafe('app/Http/Validators/LoginValidator.ts', loginValidatorTemplate, options))
  created.push(await writeFileSafe('resources/js/components/Layout.tsx', layoutTemplate, options))
  created.push(await writeFileSafe('resources/js/pages/auth/Login.tsx', loginViewTemplate, options))
  created.push(await writeFileSafe('resources/js/pages/dashboard/Index.tsx', dashboardViewTemplate, options))
  created.push(await writeFileSafe('routes/auth.ts', routesTemplate, options))
  created.push(await writeFileSafe(`db/migrations/${timestamp()}_create_users_table.sql`, migrationTemplate, options))
  created.push(await writeFileSafe('db/seeders/UsersSeeder.ts', seederTemplate, options))

  await updateSchema()

  consola.info('Next steps:')
  consola.info('  • Register AuthProvider and session middleware in src/app.ts')
  consola.info('  • Import \'./routes/auth.js\' from src/main.ts or routes/web.ts')
  consola.info('  • Run `bun run db:migrate` and `bun run db:seed`')
  consola.info('  • Install zod if not already installed: `bun add zod`')

  return created
}
