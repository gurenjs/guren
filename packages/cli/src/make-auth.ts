import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep as pathSep } from 'node:path'
import { consola } from 'consola'
import { writeFilesSafe, type WriterOptions } from './utils'
import { addImport, addProvider } from './patch-helpers'

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

const loginControllerTemplate = `import { Controller, ValidationException } from '@guren/core'
import { LoginSchema } from '@/Http/Validators/LoginValidator'
import { pages } from '../../../../.guren/pages.gen.js'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.Login, { email }, { url: this.request.path, title: 'Login' })
  }

  async store(): Promise<Response> {
    const { email, password, remember } = await this.validateBody(LoginSchema)

    this.auth.session()?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      throw ValidationException.withMessages({ message: 'Invalid credentials.' })
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
import type { UserRecord } from '../../Models/User.js'
import { pages } from '../../../.guren/pages.gen.js'

export default class DashboardController extends Controller {
  async index(): Promise<Response> {
    const currentUser = await this.auth.user<UserRecord | null>()
    const user = currentUser
      ? {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email,
        }
      : null
    return this.inertia(pages.dashboard.Index, { user }, { url: this.request.path, title: 'Dashboard' })
  }
}
`

const profileControllerTemplate = `import { Controller, ValidationException } from '@guren/core'
import { User, type UserRecord } from '../../Models/User.js'
import { ProfileUpdateSchema } from '../Validators/ProfileValidator.js'
import { pages } from '../../../.guren/pages.gen.js'

export default class ProfileController extends Controller {
  async edit(): Promise<Response> {
    const user = await this.auth.user<UserRecord | null>()
    if (!user) {
      return this.redirect('/login')
    }

    return this.inertia(pages.profile.Edit, {
      profile: {
        name: user.name,
        email: user.email,
      },
    }, { url: this.request.path, title: 'Profile' })
  }

  async update(): Promise<Response> {
    const user = await this.auth.user<UserRecord | null>()
    if (!user) {
      return this.redirect('/login')
    }

    const { name, email, password } = await this.validateBody(ProfileUpdateSchema)

    if (email !== user.email) {
      const existing = await User.where({ email })
      const conflict = existing.find((candidate) => candidate.id !== user.id)
      if (conflict) {
        throw ValidationException.withMessages({ email: 'Email is already in use.' })
      }
    }

    await User.update({ id: user.id }, {
      name,
      email,
      ...(password ? { password } : {}),
    })

    const refreshed = await User.find(user.id)
    if (refreshed) {
      await this.auth.login(refreshed)
    }

    return this.inertia(pages.profile.Edit, {
      profile: { name, email },
      status: 'Profile updated successfully.',
    }, { url: this.request.path, title: 'Profile' })
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

const authProviderTemplate = `import { ServiceProvider } from '@guren/core'
import type { AuthManager } from '@guren/core'
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
}
`

const loginValidatorTemplate = `import { z } from 'zod'

export const LoginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .email('The email address is badly formatted.'),
  password: z
    .string()
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

const profileValidatorTemplate = `import { z } from 'zod'

export const ProfileUpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(120, 'Name must be 120 characters or fewer.'),
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .email('Enter a valid email address.'),
  password: z
    .string()
    .trim()
    .optional()
    .transform((value) => value ?? '')
    .refine((value) => value === '' || value.length >= 8, 'Password must be at least 8 characters.'),
})

export type ProfileUpdateInput = z.infer<typeof ProfileUpdateSchema>
`

const layoutTemplate = `import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'

export default function Layout({ children }: PropsWithChildren) {
  const { props } = usePage<{ auth?: { user?: { name?: string } } }>()
  const user = props.auth?.user

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

const loginViewTemplate = `import { Head, Link, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  email?: string
  errors?: ValidationErrors<'email' | 'password'>
}

type LoginFormData = {
  email: string
  password: string
  remember: boolean
}

export default function Login({ email = '', errors = {} }: Props) {
  const form = useForm<LoginFormData>({
    email,
    password: '',
    remember: false,
  })

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

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/login')
          }}
        >
          <div>
            <label htmlFor={emailId} className="block text-sm font-medium text-slate-200">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
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
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.password && <p className="mt-1 text-sm text-rose-300">{errors.password}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.data.remember}
              onChange={(event) => form.setData('remember', event.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-emerald-400 focus:ring-emerald-400"
            />
            Remember me
          </label>

            <button
              type="submit"
              disabled={form.processing}
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

interface Props {
  user?: { id: number; name: string; email: string } | null
}

export default function Dashboard({ user }: Props) {
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

const profileViewTemplate = `import { Head, useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  profile: { name: string; email: string }
  errors?: ValidationErrors<'name' | 'email' | 'password'>
  status?: string
}

type ProfileFormValues = {
  name: string
  email: string
  password: string
}

export default function ProfileEdit({ profile, status }: Props) {
  const form = useForm<ProfileFormValues>({
    name: profile.name,
    email: profile.email,
    password: '',
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    form.put('/profile')
  }

  return (
    <Layout>
      <Head title="Profile" />
      <section className="space-y-6 rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <header>
          <h1 className="text-2xl font-semibold text-emerald-300">Profile</h1>
          <p className="mt-2 text-sm text-slate-400">Update your account details and password.</p>
        </header>

        {status ? (
          <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            {status}
          </p>
        ) : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="block text-sm font-medium text-slate-200">Name</label>
            <input
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.name ? <p className="mt-1 text-sm text-rose-300">{form.errors.name}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-200">Email</label>
            <input
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.email ? <p className="mt-1 text-sm text-rose-300">{form.errors.email}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-200">New password</label>
            <input
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.password ? <p className="mt-1 text-sm text-rose-300">{form.errors.password}</p> : null}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Save changes
          </button>
        </form>
      </section>
    </Layout>
  )
}
`

const routesTemplate = `import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'

export function registerAuthRoutes(router: Router): void {
  router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')
  router.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('login.store')
  router.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')

  router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('dashboard')
  router.get('/profile', [ProfileController, 'edit'], requireAuthenticated({ redirectTo: '/login' })).name('profile.edit')
  router.put('/profile', [ProfileController, 'update'], requireAuthenticated({ redirectTo: '/login' })).name('profile.update')
}

export default registerAuthRoutes
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

async function updatePageContracts(): Promise<void> {
  // contracts.ts has been removed; Props are now defined directly in page components
}

export interface MakeAuthOptions extends WriterOptions {
  install?: boolean
}

export async function makeAuth(options: MakeAuthOptions = {}): Promise<string[]> {
  const migrationPath = `db/migrations/${timestamp()}_create_users_table.sql`
  const created = await writeFilesSafe([
    { path: 'app/Http/Controllers/Auth/LoginController.ts', contents: loginControllerTemplate },
    { path: 'app/Http/Controllers/DashboardController.ts', contents: dashboardControllerTemplate },
    { path: 'app/Http/Controllers/ProfileController.ts', contents: profileControllerTemplate },
    { path: 'app/Models/User.ts', contents: userModelTemplate },
    { path: 'app/Providers/AuthProvider.ts', contents: authProviderTemplate },
    { path: 'app/Http/Validators/LoginValidator.ts', contents: loginValidatorTemplate },
    { path: 'app/Http/Validators/ProfileValidator.ts', contents: profileValidatorTemplate },
    { path: 'resources/js/components/Layout.tsx', contents: layoutTemplate },
    { path: 'resources/js/pages/auth/Login.tsx', contents: loginViewTemplate },
    { path: 'resources/js/pages/dashboard/Index.tsx', contents: dashboardViewTemplate },
    { path: 'resources/js/pages/profile/Edit.tsx', contents: profileViewTemplate },
    { path: 'routes/auth.ts', contents: routesTemplate },
    { path: migrationPath, contents: migrationTemplate },
    { path: 'db/seeders/UsersSeeder.ts', contents: seederTemplate },
  ], options)

  await updateSchema()
  await updatePageContracts()

  if (options.install) {
    await installAuth()
  } else {
    consola.info('Next steps:')
    consola.info('  • Register AuthProvider in src/app.ts providers array')
    consola.info('  • Import registerAuthRoutes from routes/auth.ts and call it from your routes/web.ts registrar')
    consola.info('  • Run `bun run db:migrate` and `bun run db:seed`')
    consola.info('  • Install zod if not already installed: `bun add zod`')
    consola.info('')
    consola.info('Session middleware is auto-configured when AuthProvider is registered.')
  }

  return created
}

async function installAuth(): Promise<void> {
  consola.info('Installing authentication configuration...')

  // Determine app file location (try src/app.ts first, then app.ts)
  const appPaths = ['src/app.ts', 'app.ts']
  let appPath: string | undefined

  for (const path of appPaths) {
    try {
      await readFile(resolve(process.cwd(), path), 'utf8')
      appPath = path
      break
    } catch {
      // File doesn't exist, try next
    }
  }

  if (!appPath) {
    consola.warn('Could not find src/app.ts or app.ts - skipping auto-configuration')
    consola.info('Please manually register AuthProvider in your Application providers')
    return
  }

  // Add AuthProvider import
  const authProviderImportPath = (() => {
    const base = dirname(appPath)
    const rel = relative(base, 'app/Providers/AuthProvider.js') || 'app/Providers/AuthProvider.js'
    const normalized = rel.split(pathSep).join('/').replace(/^\.$/, 'app/Providers/AuthProvider.js')
    return normalized.startsWith('.') ? normalized : `./${normalized}`
  })()
  const authProviderImport = `import AuthProvider from '${authProviderImportPath}'`

  const authImportResult = await addImport(appPath, authProviderImport)
  if (authImportResult.modified) {
    consola.success(`Added AuthProvider import to ${appPath}`)
  } else if (authImportResult.reason === 'Import already exists') {
    consola.info(`AuthProvider import already exists in ${appPath}`)
  }

  // Add AuthProvider to providers array
  const providerResult = await addProvider(appPath, 'AuthProvider')
  if (providerResult.modified) {
    consola.success(`Added AuthProvider to providers array in ${appPath}`)
  } else if (providerResult.reason === 'Provider already registered') {
    consola.info(`AuthProvider already registered in ${appPath}`)
  } else {
    consola.warn(`Could not add AuthProvider: ${providerResult.reason}`)
  }

  // Add auth routes import to routes/web.ts
  const webRoutesPath = 'routes/web.ts'
  try {
    const absoluteWebRoutesPath = resolve(process.cwd(), webRoutesPath)
    let routesContent = await readFile(absoluteWebRoutesPath, 'utf8')
    const routesImport = "import registerAuthRoutes from './auth.js'"
    const routesImportResult = await addImport(webRoutesPath, routesImport)

    if (routesImportResult.modified) {
      consola.success(`Added auth route registrar import to ${webRoutesPath}`)
    } else if (routesImportResult.reason === 'Import already exists') {
      consola.info(`Auth route registrar import already exists in ${webRoutesPath}`)
    }

    routesContent = await readFile(absoluteWebRoutesPath, 'utf8')

    if (!routesContent.includes('registerAuthRoutes(router)')) {
      const registrarPattern = /(export function [^(]+\(\s*router\s*:\s*Router\s*\)\s*(?::\s*[^{]+)?\{\n)/u
      if (registrarPattern.test(routesContent)) {
        routesContent = routesContent.replace(registrarPattern, `$1  registerAuthRoutes(router)\n`)
        await writeFile(absoluteWebRoutesPath, routesContent, 'utf8')
        consola.success(`Registered auth routes inside ${webRoutesPath}`)
      } else {
        consola.warn(`Could not locate a route registrar in ${webRoutesPath} - add registerAuthRoutes(router) manually`)
      }
    }
  } catch {
    consola.warn(`Could not find ${webRoutesPath} - you may need to manually import and call registerAuthRoutes(router)`)
  }

  consola.success('Authentication configuration installed!')
  consola.info('Session middleware is auto-configured via AuthServiceProvider (autoSession: true)')
  consola.info('Next steps:')
  consola.info('  • Run `bun run db:migrate` to create the users table')
  consola.info('  • Run `bun run db:seed` to create demo user')
  consola.info('  • Start the dev server and visit /login')
}
