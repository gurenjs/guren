import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep as pathSep } from 'node:path'
import { consola } from 'consola'
import { writeFilesSafe, type WriterOptions } from './utils'
import {
  addImport,
  addProvider,
  addCreateAppOption,
  ensureDrizzleImports,
  ensureMysqlImports,
  ensureSqliteImports,
} from './patch-helpers'
import { makeMigration } from './make-migration'

const loginControllerTemplate = `import { Controller, ValidationException } from '@guren/core'
import { LoginSchema } from '../../Validators/LoginValidator.js'
import { pages } from '@/.guren/pages.gen'

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

const registerControllerTemplate = `import { Controller, ValidationException } from '@guren/core'
import { RegisterSchema } from '../../Validators/RegisterValidator.js'
import { User } from '../../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class RegisterController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.Register, {}, { url: this.request.path, title: 'Register' })
  }

  async store(): Promise<Response> {
    const { name, email, password } = await this.validateBody(RegisterSchema)

    const existing = await User.where({ email })
    if (existing.length > 0) {
      throw ValidationException.withMessages({ email: 'An account with this email already exists.' })
    }

    // AuthenticatableModel hashes the virtual \`password\` field into
    // \`passwordHash\` before persisting — see app/Models/User.ts.
    const user = await User.create({ name, email, password })

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect('/dashboard')
  }
}
`

const forgotPasswordControllerTemplate = `import { Controller, createPasswordResetToken, buildPasswordResetUrl } from '@guren/core'
import { ForgotPasswordSchema } from '../../Validators/ForgotPasswordValidator.js'
import { User } from '../../../Models/User.js'
import { passwordResetStore } from '../../../Auth/PasswordResetStore.js'
import { sendPasswordResetMail } from '../../../Mail/PasswordResetMail.js'
import { pages } from '@/.guren/pages.gen'

const STATUS_MESSAGE = "If an account exists for that email, we've sent a password reset link."

export default class ForgotPasswordController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.ForgotPassword, {}, { url: this.request.path, title: 'Forgot password' })
  }

  async store(): Promise<Response> {
    const { email } = await this.validateBody(ForgotPasswordSchema)

    // Always respond with the same status message whether or not the
    // account exists, to avoid leaking which emails are registered.
    const [user] = await User.where({ email })
    if (user) {
      const { token } = await createPasswordResetToken(email, passwordResetStore)
      const resetUrl = buildPasswordResetUrl(\`\${new URL(this.request.url).origin}/reset-password\`, token, email)
      await sendPasswordResetMail(this.make('mail'), email, resetUrl)
    }

    return this.inertia(pages.auth.ForgotPassword, { status: STATUS_MESSAGE }, {
      url: this.request.path,
      title: 'Forgot password',
    })
  }
}
`

const resetPasswordControllerTemplate = `import { Controller, ValidationException, verifyPasswordResetToken } from '@guren/core'
import { ResetPasswordSchema } from '../../Validators/ResetPasswordValidator.js'
import { User } from '../../../Models/User.js'
import { passwordResetStore } from '../../../Auth/PasswordResetStore.js'
import { pages } from '@/.guren/pages.gen'

const INVALID_TOKEN_MESSAGE = 'This password reset link is invalid or has expired.'

export default class ResetPasswordController extends Controller {
  async show(): Promise<Response> {
    const token = this.request.query('token') ?? ''
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.ResetPassword, { token, email }, {
      url: this.request.path,
      title: 'Reset password',
    })
  }

  async store(): Promise<Response> {
    const { token, password } = await this.validateBody(ResetPasswordSchema)

    const email = await verifyPasswordResetToken(token, passwordResetStore)
    if (!email) {
      throw ValidationException.withMessages({ token: INVALID_TOKEN_MESSAGE })
    }

    const [user] = await User.where({ email })
    if (!user) {
      throw ValidationException.withMessages({ token: INVALID_TOKEN_MESSAGE })
    }

    // AuthenticatableModel hashes the virtual \`password\` field into
    // \`passwordHash\` before persisting — see app/Models/User.ts.
    await User.update({ id: user.id }, { password })
    await passwordResetStore.deleteForEmail(email)

    return this.redirect('/login')
  }
}
`

const dashboardControllerTemplate = `import { Controller } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

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
import { pages } from '@/.guren/pages.gen'

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

  // Never serialized by Model.serialize() and stripped from auth.user()
  static override hidden = ['passwordHash', 'rememberToken']
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

const mailConfigTemplate = `import type { MailConfig } from '@guren/core'

// Defaults to the \`log\` driver, which prints outgoing emails to the
// console instead of sending them — nothing to configure for local
// development. Set MAIL_DRIVER=smtp (and the SMTP_* variables below)
// once you're ready to send real email.
export const mailConfig: MailConfig = {
  default: process.env.MAIL_DRIVER ?? 'log',
  from: {
    email: process.env.MAIL_FROM_ADDRESS ?? 'noreply@example.com',
    name: process.env.MAIL_FROM_NAME ?? 'Guren',
  },
  transports: {
    log: { driver: 'log' },
    smtp: {
      driver: 'smtp',
      host: process.env.SMTP_HOST ?? 'localhost',
      port: Number(process.env.SMTP_PORT ?? 587),
      auth: {
        user: process.env.SMTP_USER ?? '',
        pass: process.env.SMTP_PASS ?? '',
      },
    },
  },
}
`

const mailProviderTemplate = `import { ServiceProvider, createMailManager } from '@guren/core'
import { mailConfig } from '../../config/mail.js'

export default class MailProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('mail', () => createMailManager(mailConfig))
  }
}
`

const passwordResetStoreTemplate = `import { MemoryPasswordResetStore } from '@guren/core'

// Swap for a Redis-backed store (see @guren/server/redis) in production
// or any multi-instance deployment — this in-memory store does not
// survive restarts and is not shared across processes.
export const passwordResetStore = new MemoryPasswordResetStore()
`

const passwordResetMailTemplate = `import { mail, type MailManager } from '@guren/core'

export async function sendPasswordResetMail(manager: MailManager, email: string, resetUrl: string): Promise<void> {
  await mail(manager)
    .to(email)
    .subject('Reset your password')
    .html(\`
      <h1>Reset your password</h1>
      <p>Click the link below to choose a new password. This link expires in 1 hour.</p>
      <p><a href="\${resetUrl}">\${resetUrl}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    \`)
    .text(\`
Reset your password

Click the link below to choose a new password. This link expires in 1 hour.

\${resetUrl}

If you didn't request this, you can safely ignore this email.
    \`)
    .send()
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

const registerValidatorTemplate = `import { z } from 'zod'

export const RegisterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required.')
      .max(120, 'Name must be 120 characters or fewer.'),
    email: z
      .string()
      .trim()
      .min(1, 'Email is required.')
      .email('The email address is badly formatted.'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters.'),
    passwordConfirmation: z
      .string()
      .min(1, 'Please confirm your password.'),
  })
  .refine((data) => data.password === data.passwordConfirmation, {
    message: 'Passwords do not match.',
    path: ['passwordConfirmation'],
  })

export type RegisterInput = z.infer<typeof RegisterSchema>
`

const forgotPasswordValidatorTemplate = `import { z } from 'zod'

export const ForgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .email('The email address is badly formatted.'),
})

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>
`

const resetPasswordValidatorTemplate = `import { z } from 'zod'

export const ResetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Reset token is required.'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters.'),
    passwordConfirmation: z
      .string()
      .min(1, 'Please confirm your password.'),
  })
  .refine((data) => data.password === data.passwordConfirmation, {
    message: 'Passwords do not match.',
    path: ['passwordConfirmation'],
  })

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>
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

function buildLoginViewTemplate(includeRegister: boolean, includeReset: boolean): string {
  const signUpLink = includeRegister
    ? `
        <p className="mt-2 text-center text-sm text-slate-400">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-emerald-300 transition hover:text-emerald-200">
            Sign up
          </Link>
        </p>`
    : ''

  const forgotPasswordText = includeReset
    ? `
        <p className="mt-6 text-center text-sm text-slate-400">
          <Link href="/forgot-password" className="text-emerald-300 transition hover:text-emerald-200">
            Forgot your password?
          </Link>
        </p>`
    : `
        <p className="mt-6 text-center text-sm text-slate-400">
          Forgot your password? Contact your administrator.
        </p>`

  return `import { Head, Link, useForm } from '@inertiajs/react'
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

${forgotPasswordText}${signUpLink}
      </section>
    </Layout>
  )
}
`
}

const registerViewTemplate = `import { Head, Link, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'name' | 'email' | 'password' | 'passwordConfirmation'>
}

type RegisterFormData = {
  name: string
  email: string
  password: string
  passwordConfirmation: string
}

export default function Register({ errors = {} }: Props) {
  const form = useForm<RegisterFormData>({
    name: '',
    email: '',
    password: '',
    passwordConfirmation: '',
  })

  const nameId = useId()
  const emailId = useId()
  const passwordId = useId()
  const passwordConfirmationId = useId()

  return (
    <Layout>
      <Head title="Sign up" />
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Create an account</h1>
        <p className="mt-2 text-sm text-slate-400">
          Sign up to get started.
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
            form.post('/register')
          }}
        >
          <div>
            <label htmlFor={nameId} className="block text-sm font-medium text-slate-200">
              Name
            </label>
            <input
              id={nameId}
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.name && <p className="mt-1 text-sm text-rose-300">{errors.name}</p>}
          </div>

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

          <div>
            <label htmlFor={passwordConfirmationId} className="block text-sm font-medium text-slate-200">
              Confirm password
            </label>
            <input
              id={passwordConfirmationId}
              type="password"
              value={form.data.passwordConfirmation}
              onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.passwordConfirmation && (
              <p className="mt-1 text-sm text-rose-300">{errors.passwordConfirmation}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Create account
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-400">
          Already have an account?{' '}
          <Link href="/login" className="text-emerald-300 transition hover:text-emerald-200">
            Sign in
          </Link>
        </p>
      </section>
    </Layout>
  )
}
`

const forgotPasswordViewTemplate = `import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors<'email'>
  status?: string
}

type ForgotPasswordFormData = {
  email: string
}

export default function ForgotPassword({ errors = {}, status }: Props) {
  const form = useForm<ForgotPasswordFormData>({ email: '' })

  const emailId = useId()

  return (
    <Layout>
      <Head title="Forgot password" />
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Forgot your password?</h1>
        <p className="mt-2 text-sm text-slate-400">
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>

        {status ? (
          <p className="mt-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            {status}
          </p>
        ) : null}

        {errors.message && (
          <p className="mt-4 rounded border border-rose-500/60 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            {errors.message}
          </p>
        )}

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/forgot-password')
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

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Send reset link
          </button>
        </form>
      </section>
    </Layout>
  )
}
`

const resetPasswordViewTemplate = `import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  token: string
  email: string
  errors?: ValidationErrors<'token' | 'password' | 'passwordConfirmation'>
}

type ResetPasswordFormData = {
  token: string
  password: string
  passwordConfirmation: string
}

export default function ResetPassword({ token, email, errors = {} }: Props) {
  const form = useForm<ResetPasswordFormData>({
    token,
    password: '',
    passwordConfirmation: '',
  })

  const passwordId = useId()
  const passwordConfirmationId = useId()

  return (
    <Layout>
      <Head title="Reset password" />
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Reset your password</h1>
        {email ? (
          <p className="mt-2 text-sm text-slate-400">
            Choose a new password for {email}.
          </p>
        ) : null}

        {errors.token && (
          <p className="mt-4 rounded border border-rose-500/60 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            {errors.token}
          </p>
        )}

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/reset-password')
          }}
        >
          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-slate-200">
              New password
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

          <div>
            <label htmlFor={passwordConfirmationId} className="block text-sm font-medium text-slate-200">
              Confirm new password
            </label>
            <input
              id={passwordConfirmationId}
              type="password"
              value={form.data.passwordConfirmation}
              onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
              required
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {errors.passwordConfirmation && (
              <p className="mt-1 text-sm text-rose-300">{errors.passwordConfirmation}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Reset password
          </button>
        </form>
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

function buildRoutesTemplate(includeRegister: boolean, includeReset: boolean): string {
  const registerImport = includeRegister
    ? `\nimport RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'`
    : ''
  const registerRoutes = includeRegister
    ? `
  router.get('/register', [RegisterController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('register')
  router.post('/register', [RegisterController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('register.store')
`
    : ''

  const resetImport = includeReset
    ? `\nimport ForgotPasswordController from '../app/Http/Controllers/Auth/ForgotPasswordController.js'\nimport ResetPasswordController from '../app/Http/Controllers/Auth/ResetPasswordController.js'`
    : ''
  const resetRoutes = includeReset
    ? `
  router.get('/forgot-password', [ForgotPasswordController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('forgot-password')
  router.post('/forgot-password', [ForgotPasswordController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('forgot-password.store')
  router.get('/reset-password', [ResetPasswordController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('reset-password')
  router.post('/reset-password', [ResetPasswordController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('reset-password.store')
`
    : ''

  return `import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'${registerImport}${resetImport}
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'

export function registerAuthRoutes(router: Router): void {
  router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')
  router.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('login.store')
  router.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')
${registerRoutes}${resetRoutes}
  router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('dashboard')
  router.get('/profile', [ProfileController, 'edit'], requireAuthenticated({ redirectTo: '/login' })).name('profile.edit')
  router.put('/profile', [ProfileController, 'update'], requireAuthenticated({ redirectTo: '/login' })).name('profile.update')
}
`
}

const seederTemplate = `import { defineSeeder, ScryptHasher } from '@guren/core'
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

type SchemaDialect = 'sqlite' | 'pg' | 'mysql'

function detectSchemaDialect(content: string): SchemaDialect {
  if (content.includes('sqliteTable') || content.includes('drizzle-orm/sqlite-core')) {
    return 'sqlite'
  }
  if (content.includes('mysqlTable') || content.includes('drizzle-orm/mysql-core')) {
    return 'mysql'
  }
  return 'pg'
}

const usersTableBlocks: Record<SchemaDialect, string> = {
  sqlite: `export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updated_at').notNull().$defaultFn(() => new Date().toISOString()),
})
`,
  pg: `export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: timestamp('created_at', { withTimezone: false }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: false }).defaultNow().notNull(),
})
`,
  mysql: `export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  rememberToken: varchar('remember_token', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
`,
}

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

  // Keep the schema in the dialect the app was scaffolded with
  const dialect = detectSchemaDialect(content)

  if (dialect === 'sqlite') {
    content = ensureSqliteImports(content, ['sqliteTable', 'integer', 'text'])
  } else if (dialect === 'mysql') {
    content = ensureMysqlImports(content, ['mysqlTable', 'int', 'varchar', 'timestamp'])
  } else {
    content = ensureDrizzleImports(content, ['pgTable', 'serial', 'text', 'timestamp'])
  }

  // Replace an existing users table that lacks auth columns, or append if absent
  // Use `})` on its own line as the end anchor to avoid premature matching
  // inside nested function calls like `$defaultFn(() => ...)`
  const usersTablePattern = /export const users = (?:pgTable|sqliteTable|mysqlTable)\('users',\s*\{[\s\S]*?\n\}\)\s*\n?/
  const usersTableBlock = usersTableBlocks[dialect]

  if (usersTablePattern.test(content)) {
    content = content.replace(usersTablePattern, usersTableBlock)
  } else {
    content = `${content.trimEnd()}\n\n${usersTableBlock}`
  }

  await writeFile(schemaPath, content, 'utf8')
  consola.info(`Updated db/schema.ts with authentication columns (${dialect}).`)
}

async function generateUsersMigration(): Promise<boolean> {
  const { existsSync } = await import('node:fs')
  if (!existsSync(resolve(process.cwd(), 'node_modules', 'drizzle-kit'))) {
    consola.info('drizzle-kit is not installed — run `bun run db:make` after `bun install` to generate the users migration.')
    return false
  }

  try {
    await makeMigration({ name: 'create_users_table' })
    consola.success('Generated users table migration via drizzle-kit.')
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    consola.warn(`Could not generate the users migration automatically (${reason}).`)
    consola.info('Run `bun run db:make` (drizzle-kit generate) to create it from db/schema.ts.')
    return false
  }
}

async function updatePageContracts(): Promise<void> {
}

export interface MakeAuthOptions extends WriterOptions {
  install?: boolean
  /** Skip registration scaffolding and generate the login-only experience. */
  minimal?: boolean
}

export async function makeAuth(options: MakeAuthOptions = {}): Promise<string[]> {
  const includeExtras = !options.minimal

  const files = [
    { path: 'app/Http/Controllers/Auth/LoginController.ts', contents: loginControllerTemplate },
    { path: 'app/Http/Controllers/DashboardController.ts', contents: dashboardControllerTemplate },
    { path: 'app/Http/Controllers/ProfileController.ts', contents: profileControllerTemplate },
    { path: 'app/Models/User.ts', contents: userModelTemplate },
    { path: 'app/Providers/AuthProvider.ts', contents: authProviderTemplate },
    { path: 'app/Http/Validators/LoginValidator.ts', contents: loginValidatorTemplate },
    { path: 'app/Http/Validators/ProfileValidator.ts', contents: profileValidatorTemplate },
    { path: 'resources/js/components/Layout.tsx', contents: layoutTemplate },
    { path: 'resources/js/pages/auth/Login.tsx', contents: buildLoginViewTemplate(includeExtras, includeExtras) },
    { path: 'resources/js/pages/dashboard/Index.tsx', contents: dashboardViewTemplate },
    { path: 'resources/js/pages/profile/Edit.tsx', contents: profileViewTemplate },
    { path: 'routes/auth.ts', contents: buildRoutesTemplate(includeExtras, includeExtras) },
    { path: 'db/seeders/UsersSeeder.ts', contents: seederTemplate },
  ]

  if (includeExtras) {
    files.push(
      { path: 'app/Http/Controllers/Auth/RegisterController.ts', contents: registerControllerTemplate },
      { path: 'app/Http/Validators/RegisterValidator.ts', contents: registerValidatorTemplate },
      { path: 'resources/js/pages/auth/Register.tsx', contents: registerViewTemplate },
      { path: 'app/Http/Controllers/Auth/ForgotPasswordController.ts', contents: forgotPasswordControllerTemplate },
      { path: 'app/Http/Controllers/Auth/ResetPasswordController.ts', contents: resetPasswordControllerTemplate },
      { path: 'app/Http/Validators/ForgotPasswordValidator.ts', contents: forgotPasswordValidatorTemplate },
      { path: 'app/Http/Validators/ResetPasswordValidator.ts', contents: resetPasswordValidatorTemplate },
      { path: 'resources/js/pages/auth/ForgotPassword.tsx', contents: forgotPasswordViewTemplate },
      { path: 'resources/js/pages/auth/ResetPassword.tsx', contents: resetPasswordViewTemplate },
      { path: 'app/Auth/PasswordResetStore.ts', contents: passwordResetStoreTemplate },
      { path: 'app/Mail/PasswordResetMail.ts', contents: passwordResetMailTemplate },
      { path: 'app/Providers/MailProvider.ts', contents: mailProviderTemplate },
      { path: 'config/mail.ts', contents: mailConfigTemplate },
    )
  }

  const created = await writeFilesSafe(files, options)

  await updateSchema()
  await updatePageContracts()
  const migrationGenerated = await generateUsersMigration()

  if (options.install) {
    await installAuth(migrationGenerated, includeExtras)
  } else {
    consola.info('Next steps:')
    consola.info('  • Register AuthProvider in src/app.ts providers array')
    consola.info('  • Enable sessions and CSRF by adding `auth: {}` to your createApp() options')
    consola.info('  • Import registerAuthRoutes from routes/auth.ts and call it from your routes/web.ts registrar')
    if (includeExtras) {
      consola.info('  • Register MailProvider in src/app.ts providers array (used to send password reset emails)')
    }
    if (!migrationGenerated) {
      consola.info('  • Run `bun run db:make` to generate the users migration')
    }
    consola.info('  • Run `bun run db:migrate` and `bun run db:seed`')
    consola.info('  • Install zod if not already installed: `bun add zod`')
  }

  return created
}

async function wireProvider(appPath: string, providerName: string, providerRelativePath: string): Promise<void> {
  const importPath = (() => {
    const base = dirname(appPath)
    const rel = relative(base, providerRelativePath) || providerRelativePath
    const normalized = rel.split(pathSep).join('/').replace(/^\.$/, providerRelativePath)
    return normalized.startsWith('.') ? normalized : `./${normalized}`
  })()

  const importResult = await addImport(appPath, `import ${providerName} from '${importPath}'`)
  if (importResult.modified) {
    consola.success(`Added ${providerName} import to ${appPath}`)
  } else if (importResult.reason === 'Import already exists') {
    consola.info(`${providerName} import already exists in ${appPath}`)
  }

  const providerResult = await addProvider(appPath, providerName)
  if (providerResult.modified) {
    consola.success(`Added ${providerName} to providers array in ${appPath}`)
  } else if (providerResult.reason === 'Provider already registered') {
    consola.info(`${providerName} already registered in ${appPath}`)
  } else {
    consola.warn(`Could not add ${providerName}: ${providerResult.reason}`)
  }
}

async function installAuth(migrationGenerated = true, includeExtras = true): Promise<void> {
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

  await wireProvider(appPath, 'AuthProvider', 'app/Providers/AuthProvider.js')

  if (includeExtras) {
    // Wire CoreMailServiceProvider before our own MailProvider — matching
    // the `guren add mail` blueprint's convention — so `container.singleton(
    // 'mail', ...)` resolves to our configured manager rather than Core's
    // empty-config default, regardless of whether `add mail` also runs
    // (before or after this) against the same app.
    const coreMailImportResult = await addImport(appPath, "import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'")
    if (coreMailImportResult.modified) {
      consola.success(`Added CoreMailServiceProvider import to ${appPath}`)
    }
    const coreMailProviderResult = await addProvider(appPath, 'CoreMailServiceProvider')
    if (coreMailProviderResult.modified) {
      consola.success(`Added CoreMailServiceProvider to providers array in ${appPath}`)
    } else if (coreMailProviderResult.reason !== 'Provider already registered') {
      consola.warn(`Could not add CoreMailServiceProvider: ${coreMailProviderResult.reason}`)
    }

    await wireProvider(appPath, 'MailProvider', 'app/Providers/MailProvider.js')
  }

  // Enable session + CSRF middleware: AuthServiceProvider is only registered
  // when createApp() receives an `auth` option.
  const authOptionResult = await addCreateAppOption(appPath, 'auth', '{}')
  if (authOptionResult.modified) {
    consola.success(`Enabled sessions and CSRF via auth option in ${appPath}`)
  } else if (authOptionResult.reason === 'Option already set') {
    consola.info(`auth option already set in ${appPath}`)
  } else {
    consola.warn(`Could not set the auth option automatically: ${authOptionResult.reason}`)
    consola.info('Add `auth: {}` to your createApp() options to enable sessions and CSRF.')
  }

  // Add auth routes import to routes/web.ts
  const webRoutesPath = 'routes/web.ts'
  try {
    const absoluteWebRoutesPath = resolve(process.cwd(), webRoutesPath)
    let routesContent = await readFile(absoluteWebRoutesPath, 'utf8')
    const routesImport = "import { registerAuthRoutes } from './auth.js'"
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
  if (!migrationGenerated) {
    consola.info('  • Run `bun run db:make` to generate the users migration')
  }
  consola.info('  • Run `bun run db:migrate` to create the users table')
  consola.info('  • Run `bun run db:seed` to create demo user')
  consola.info('  • Start the dev server and visit /login (demo@example.com / secret)')
}
