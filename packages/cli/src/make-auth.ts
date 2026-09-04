import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { assertCwdUnsupported, writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'
import { assertNotApiOnly } from './app-surface'
import {
  addCreateAppOption,
  detectSchemaDialect,
  ensureMysqlImports,
  ensurePgImports,
  ensureSqliteImports,
  PATCH_REASONS,
  readSchemaDialect,
  seederContextTypes,
  type SchemaDialect,
} from './patch-helpers'
import { readIfExists } from './discovery'
import { APP_ENTRY_CANDIDATES, resolveAppEntry, wireAppProvider, wireProvider } from './provider-registrar'
import { wireRouteRegistrar } from './route-registrar'
import { makeMigration } from './make-migration'
import { ensureGurenUiTokens, FIELD_LABEL_CLASS, FORM_INPUT_CLASS, PRIMARY_SUBMIT_CLASS } from './guren-css'
import { scaffoldTemplateFile } from './scaffold-templates'

function authFile(path: string): ScaffoldFileEntry {
  return scaffoldTemplateFile('auth', path)
}

/** The page heading with the ember tick — the one structural device, once per
    screen. `indent` is the emitted indentation of the `<h1>` line, so every
    builder renders the identical block at its own depth. */
function tickHeading(title: string, indent: string): string {
  return `<h1 className="flex items-center gap-3 text-2xl font-bold text-g-heading">
${indent}  <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
${indent}  ${title}
${indent}</h1>`
}

/** A flash/error message as a diagnostic row: mono key in a fixed gutter, a
    hairline, ordinary body text — the shape of `guren check` output, no
    tinted box. The tone doubles as the printed key. */
function calloutRow(tone: 'ok' | 'error', body: string, indent: string, { flush = false } = {}): string {
  const color = tone === 'ok' ? 'text-g-ok' : 'text-g-danger'
  return `<p className="${flush ? '' : 'mt-4 '}flex gap-3 border-y border-g-line py-2.5 text-sm">
${indent}  <span className="w-10 shrink-0 text-right font-mono text-xs font-bold leading-5 ${color}">${tone}</span>
${indent}  <span className="text-g-text">${body}</span>
${indent}</p>`
}

// A passwordless app keeps show() and destroy() but registers no POST /login,
// so a scaffolded store() would be dead code pulling in the password validator.
function buildLoginControllerTemplate(includePassword: boolean): string {
  const coreImports = includePassword ? 'Controller, ValidationException' : 'Controller'
  const validatorImport = includePassword
    ? `\nimport { LoginSchema } from '../../Validators/LoginValidator.js'`
    : ''

  const showBody = includePassword
    ? `    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.Login, { email }, { title: 'Login' })`
    : `    return this.inertia(pages.auth.Login, {}, { title: 'Login' })`

  const storeAction = includePassword
    ? `
  async store(): Promise<Response> {
    const { email, password, remember } = await this.validateBody(LoginSchema)

    this.auth.session()?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      throw ValidationException.withMessages({ message: 'Invalid credentials.' })
    }

    return this.redirect('/dashboard')
  }
`
    : ''

  return `import { ${coreImports} } from '@guren/core'${validatorImport}
import { pages } from '@/.guren/pages.gen'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
${showBody}
  }
${storeAction}
  async destroy(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()
    return this.redirect('/')
  }
}
`
}

function buildRegisterControllerTemplate(includeVerify: boolean): string {
  const coreImports = includeVerify
    ? 'Controller, ValidationException, createEmailVerificationToken, buildVerificationUrl'
    : 'Controller, ValidationException'

  const verifyImports = includeVerify
    ? `
import { emailVerificationStore } from '../../../Auth/EmailVerificationStore.js'
import { appUrl } from '../../../Auth/AppUrl.js'
import { sendEmailVerificationMail } from '../../../Mail/EmailVerificationMail.js'`
    : ''

  const sendVerification = includeVerify
    ? `
    const { token } = await createEmailVerificationToken(user.email, emailVerificationStore)
    const verifyUrl = buildVerificationUrl(\`\${appUrl(this.request)}/verify-email/confirm\`, token, user.email)
    await sendEmailVerificationMail(this.make('mail'), user.email, verifyUrl)
`
    : ''

  const redirectPath = includeVerify ? '/verify-email' : '/dashboard'

  return `import { ${coreImports} } from '@guren/core'
import { RegisterSchema } from '../../Validators/RegisterValidator.js'
import { User } from '../../../Models/User.js'${verifyImports}
import { pages } from '@/.guren/pages.gen'

export default class RegisterController extends Controller {
  async show(): Promise<Response> {
    return this.inertia(pages.auth.Register, {}, { title: 'Register' })
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
${sendVerification}
    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect('${redirectPath}')
  }
}
`
}

const OAUTH_PROVIDER_FACTORIES: Record<string, string> = {
  github: 'createGitHubOAuthProviderConfig',
  google: 'createGoogleOAuthProviderConfig',
  discord: 'createDiscordOAuthProviderConfig',
}

function buildOAuthProviderTemplate(providers: string[]): string {
  const factoryImports = providers.map((provider) => OAUTH_PROVIDER_FACTORIES[provider]).join(', ')

  const registrations = providers
    .map((provider) => {
      const upper = provider.toUpperCase()
      return `    const ${provider}ClientId = process.env.OAUTH_${upper}_CLIENT_ID
    const ${provider}ClientSecret = process.env.OAUTH_${upper}_CLIENT_SECRET
    const ${provider}RedirectUri = process.env.OAUTH_${upper}_REDIRECT_URI
    if (${provider}ClientId && ${provider}ClientSecret && ${provider}RedirectUri) {
      oauth.registerProvider('${provider}', ${OAUTH_PROVIDER_FACTORIES[provider]}({
        clientId: ${provider}ClientId,
        clientSecret: ${provider}ClientSecret,
        redirectUri: ${provider}RedirectUri,
      }))
    }`
    })
    .join('\n\n')

  // Matches `guren add oauth`: registered against the shared `oauth` singleton
  // and only when all three env vars are set, so a half-configured provider
  // fails app-side rather than at the provider with empty credentials.
  return `import { ServiceProvider, type OAuthManager, ${factoryImports} } from '@guren/core'

export default class OAuthProvider extends ServiceProvider {
  register(): void {
    const oauth = this.container.make<OAuthManager>('oauth')

${registrations}
  }
}
`
}

function buildOAuthControllerTemplate(providers: string[], includeVerify: boolean): string {
  const providerLiterals = providers.map((provider) => `'${provider}'`).join(', ')
  const identityEntries = providers
    .map((provider) => `    ${provider}: { ${provider}Id: profileId },`)
    .join('\n')

  // Verified on arrival, since the provider vouches for the address and this
  // controller sends no verification email — without it requireVerifiedEmail
  // would strand every OAuth user at /verify-email forever.
  const emailVerifiedAtField = includeVerify ? '\n        emailVerifiedAt: new Date(),' : ''

  return `import { Controller, ValidationException, type OAuthManager } from '@guren/core'
import { z } from 'zod'
import { User, type UserRecord } from '../../../Models/User.js'

const ProviderParamSchema = z.object({
  provider: z.enum([${providerLiterals}]),
})

const CallbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
})

type OAuthProvider = z.infer<typeof ProviderParamSchema>['provider']

function identityWhere(provider: OAuthProvider, profileId: string): Partial<UserRecord> {
  const identities: Record<OAuthProvider, Partial<UserRecord>> = {
${identityEntries}
  }
  return identities[provider]
}

export default class OAuthController extends Controller {
  private oauth(): OAuthManager {
    return this.make<OAuthManager>('oauth')
  }

  // Note: not named \`redirect\` — that would shadow the base
  // Controller.redirect() helper used below.
  async redirectToProvider(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)

    // Passing the session ties \`state\` to this browser: the manager keeps a
    // binding in it that the callback must present back. Without it an
    // attacker could authorize their own account, keep the \`code\` unconsumed,
    // and walk a visitor through the callback — logging that visitor into the
    // attacker's account.
    const { url } = await this.oauth().authorize(provider, {
      redirectTo: this.request.query('redirectTo') ?? undefined,
      session: this.auth.session(),
    })

    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)
    const { code, state } = this.validateQuery(CallbackQuerySchema)

    const { profile, redirectTo } = await this.oauth().handleCallback(provider, {
      code,
      state,
      session: this.auth.session(),
    })

    // Lowercased to match how registration stores emails; provider casing
    // isn't guaranteed to be stable across logins.
    const email = profile.email?.toLowerCase()
    if (!email) {
      throw ValidationException.withMessages({ message: 'This provider did not return an email address.' })
    }

    let [user] = await User.where(identityWhere(provider, profile.id))

    if (!user) {
      // Providers report separately whether they actually verified the
      // address — returning it in the profile is not a claim that it was
      // checked. Creating an account from an unverified one would let it claim
      // an email it does not own, and the collision check below would then turn
      // the real owner away for good. Only an explicit \`false\` is refused:
      // providers that send no signal at all leave this undefined. Checked only
      // on the create path, so an already-linked account is not locked out if
      // its provider status changes later.
      if (profile.emailVerified === false) {
        throw ValidationException.withMessages({
          message: 'Your provider has not verified this email address. Verify it with the provider and try again.',
        })
      }

      const [existingByEmail] = await User.where({ email })
      if (existingByEmail) {
        throw ValidationException.withMessages({
          message: 'An account with this email already exists. Sign in with the method you originally used.',
        })
      }

      // OAuth accounts are passwordless: the model's hashing pipeline is
      // skipped when no password is supplied, and password login safely
      // rejects accounts without a hash. Hashing a synthetic password here
      // would also blow the request CPU budget on metered runtimes
      // (Cloudflare Workers free tier).
      user = await User.create({
        name: profile.name ?? email,
        email,${emailVerifiedAtField}
        ...identityWhere(provider, profile.id),
      })
    }

    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect(redirectTo ?? '/dashboard')
  }
}
`
}

/**
 * With OAuth the only way in, the stored email is the provider's and nothing
 * here can re-verify a replacement (`--verify` is unavailable in this mode).
 * An editable form would let an account claim an address it never proved, and
 * OAuthController's collision check would then reject the real owner.
 */
function buildProviderOwnedEmailProfileControllerTemplate(includePassword: boolean): string {
  const destructuredFields = includePassword ? '{ name, password }' : '{ name }'
  const updateFields = includePassword ? '{ name, ...(password ? { password } : {}) }' : '{ name }'

  return `import { Controller } from '@guren/core'
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
    }, { title: 'Profile' })
  }

  async update(): Promise<Response> {
    const user = await this.auth.user<UserRecord | null>()
    if (!user) {
      return this.redirect('/login')
    }

    // The email belongs to the OAuth provider — it is not editable here.
    const ${destructuredFields} = await this.validateBody(ProfileUpdateSchema)

    await User.update({ id: user.id }, ${updateFields})

    const refreshed = await User.find(user.id)
    if (refreshed) {
      await this.auth.login(refreshed)
    }

    return this.inertia(pages.profile.Edit, {
      profile: { name, email: user.email },
      status: 'Profile updated successfully.',
    }, { title: 'Profile' })
  }
}
`
}

function buildProfileControllerTemplate({ includeVerify, includePassword, providerOwnedEmail }: AuthFeatures): string {
  if (providerOwnedEmail) {
    return buildProviderOwnedEmailProfileControllerTemplate(includePassword)
  }

  const coreImports = includeVerify
    ? 'Controller, ValidationException, createEmailVerificationToken, buildVerificationUrl'
    : 'Controller, ValidationException'

  const verifyImports = includeVerify
    ? `
import { emailVerificationStore } from '../../Auth/EmailVerificationStore.js'
import { appUrl } from '../../Auth/AppUrl.js'
import { sendEmailVerificationMail } from '../../Mail/EmailVerificationMail.js'`
    : ''

  const verifyResetField = includeVerify
    ? `
      // The new address hasn't been proven to belong to this user yet — an
      // arbitrary replacement email must not inherit the old address's
      // verified status.
      ...(emailChanged ? { emailVerifiedAt: null } : {}),`
    : ''

  const verifyResend = includeVerify
    ? `
    if (emailChanged) {
      const { token } = await createEmailVerificationToken(email, emailVerificationStore)
      const verifyUrl = buildVerificationUrl(\`\${appUrl(this.request)}/verify-email/confirm\`, token, email)
      await sendEmailVerificationMail(this.make('mail'), email, verifyUrl)
    }
`
    : ''

  const statusMessage = includeVerify
    ? `emailChanged
        ? 'Profile updated. Check your new email address for a verification link.'
        : 'Profile updated successfully.'`
    : `'Profile updated successfully.'`

  const destructuredFields = includePassword ? '{ name, email, password }' : '{ name, email }'
  const passwordUpdateField = includePassword
    ? `
      ...(password ? { password } : {}),`
    : ''

  return `import { ${coreImports} } from '@guren/core'
import { User, type UserRecord } from '../../Models/User.js'
import { ProfileUpdateSchema } from '../Validators/ProfileValidator.js'${verifyImports}
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
    }, { title: 'Profile' })
  }

  async update(): Promise<Response> {
    const user = await this.auth.user<UserRecord | null>()
    if (!user) {
      return this.redirect('/login')
    }

    const ${destructuredFields} = await this.validateBody(ProfileUpdateSchema)
    const emailChanged = email !== user.email

    if (emailChanged) {
      const existing = await User.where({ email })
      const conflict = existing.find((candidate) => candidate.id !== user.id)
      if (conflict) {
        throw ValidationException.withMessages({ email: 'Email is already in use.' })
      }
    }

    await User.update({ id: user.id }, {
      name,
      email,${verifyResetField}${passwordUpdateField}
    })

    const refreshed = await User.find(user.id)
    if (refreshed) {
      await this.auth.login(refreshed)
    }
${verifyResend}
    return this.inertia(pages.profile.Edit, {
      profile: { name, email },
      status: ${statusMessage},
    }, { title: 'Profile' })
  }
}
`
}

/**
 * OAuth accounts are created without a password, so `password` can only be
 * required on the create payload when password sign-up is the sole way in.
 */
function buildUserModelTemplate(requirePassword: boolean): string {
  const requireOnCreate = requirePassword ? "\n  requireOnCreate: ['password']," : ''

  return `import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  // Derived from the plain \`password\`, so callers never set it directly
  optionalOnCreate: ['passwordHash'],${requireOnCreate}
  // Never serialized by Model.serialize() and stripped from auth.user()
  hidden: ['passwordHash', 'rememberToken'],
}) {
  // passwordHash and rememberToken are denied from mass assignment by
  // AuthenticatableModel itself — no per-model configuration needed.
}
`
}

function buildProfileValidatorTemplate({ includePassword, providerOwnedEmail }: AuthFeatures): string {
  // Omitted rather than made read-only in the UI alone: Zod strips unknown
  // keys, so leaving the field out is what actually stops a hand-crafted
  // request from carrying one.
  const emailField = providerOwnedEmail
    ? ''
    : `
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .toLowerCase()
    .pipe(z.email('Enter a valid email address.')),`

  const passwordField = includePassword
    ? `
  password: z
    .string()
    .trim()
    .optional()
    .transform((value) => value ?? '')
    .refine((value) => value === '' || value.length >= 8, 'Password must be at least 8 characters.'),`
    : ''

  return `import { z } from 'zod'

export const ProfileUpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(120, 'Name must be 120 characters or fewer.'),${emailField}${passwordField}
})

export type ProfileUpdateInput = z.infer<typeof ProfileUpdateSchema>
`
}

const OAUTH_PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  discord: 'Discord',
}

function buildOAuthButtonLinks(providers: string[]): string {
  return providers
    .map(
      (provider) => `          <a
            href="/auth/${provider}"
            className="flex w-full items-center justify-center rounded-g-ctl border border-g-line-strong bg-g-panel px-4 py-2 text-sm font-bold text-g-text transition hover:border-g-muted"
          >
            Continue with ${OAUTH_PROVIDER_LABELS[provider]}
          </a>`,
    )
    .join('\n')
}

/**
 * The `divider` variant appends the buttons *below* a password form — hence
 * the "Or continue with" rule. Passwordless pages pass `divider: false`,
 * where an "or" would have nothing to refer back to.
 */
function buildOAuthButtonsTemplate(providers: string[], { divider = true } = {}): string {
  if (providers.length === 0) {
    return ''
  }

  const dividerBlock = divider
    ? `
          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-g-muted">
            <span className="h-px flex-1 bg-g-line" />
            Or continue with
            <span className="h-px flex-1 bg-g-line" />
          </div>`
    : ''

  return `
        <div className="mt-6 space-y-3">${dividerBlock}
${buildOAuthButtonLinks(providers)}
        </div>`
}

/**
 * Separate rather than more holes in buildLoginViewTemplate: this file splices
 * fragments when a variant adds or drops fields, and writes a second template
 * when the structure changes. Here the whole controlled form is gone.
 */
function buildOAuthOnlyLoginViewTemplate(providers: string[]): string {
  return `import { Head } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  errors?: ValidationErrors
}

export default function Login({ errors = {} }: Props) {
  return (
    <Layout>
      <Head title="Sign in" />
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        ${tickHeading('Sign in', '        ')}
        <p className="mt-2 text-sm text-g-text-2">
          Choose a provider to continue.
        </p>

        {errors.message && (
          ${calloutRow('error', '{errors.message}', '          ')}
        )}
${buildOAuthButtonsTemplate(providers, { divider: false })}
      </section>
    </Layout>
  )
}
`
}

function buildLoginViewTemplate(includeRegister: boolean, includeReset: boolean, oauthProviders: string[] = []): string {
  const signUpLink = includeRegister
    ? `
        <p className="mt-2 text-center text-sm text-g-text-2">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-g-accent-text transition hover:underline">
            Sign up
          </Link>
        </p>`
    : ''

  const forgotPasswordText = includeReset
    ? `
        <p className="mt-6 text-center text-sm text-g-text-2">
          <Link href="/forgot-password" className="text-g-accent-text transition hover:underline">
            Forgot your password?
          </Link>
        </p>`
    : `
        <p className="mt-6 text-center text-sm text-g-text-2">
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
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        ${tickHeading('Sign in', '        ')}
        <p className="mt-2 text-sm text-g-text-2">
          Use your account credentials to continue.
        </p>

        {errors.message && (
          ${calloutRow('error', '{errors.message}', '          ')}
        )}

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/login')
          }}
        >
          <div>
            <label htmlFor={emailId} className="${FIELD_LABEL_CLASS}">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              required
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {errors.email && <p className="mt-1 text-sm text-g-danger">{errors.email}</p>}
          </div>

          <div>
            <label htmlFor={passwordId} className="${FIELD_LABEL_CLASS}">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              required
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {errors.password && <p className="mt-1 text-sm text-g-danger">{errors.password}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm text-g-text">
            <input
              type="checkbox"
              checked={form.data.remember}
              onChange={(event) => form.setData('remember', event.target.checked)}
              className="h-4 w-4 rounded accent-g-accent"
            />
            Remember me
          </label>

            <button
              type="submit"
              disabled={form.processing}
              className="${PRIMARY_SUBMIT_CLASS}"
            >
              Sign in
          </button>
        </form>
${buildOAuthButtonsTemplate(oauthProviders)}
${forgotPasswordText}${signUpLink}
      </section>
    </Layout>
  )
}
`
}

function buildRegisterViewTemplate(oauthProviders: string[] = []): string {
  return `import { Head, Link, useForm } from '@inertiajs/react'
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
      <section className="rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        ${tickHeading('Create an account', '        ')}
        <p className="mt-2 text-sm text-g-text-2">
          Sign up to get started.
        </p>

        {errors.message && (
          ${calloutRow('error', '{errors.message}', '          ')}
        )}

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/register')
          }}
        >
          <div>
            <label htmlFor={nameId} className="${FIELD_LABEL_CLASS}">
              Name
            </label>
            <input
              id={nameId}
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              required
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {errors.name && <p className="mt-1 text-sm text-g-danger">{errors.name}</p>}
          </div>

          <div>
            <label htmlFor={emailId} className="${FIELD_LABEL_CLASS}">
              Email
            </label>
            <input
              id={emailId}
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              required
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {errors.email && <p className="mt-1 text-sm text-g-danger">{errors.email}</p>}
          </div>

          <div>
            <label htmlFor={passwordId} className="${FIELD_LABEL_CLASS}">
              Password
            </label>
            <input
              id={passwordId}
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              required
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {errors.password && <p className="mt-1 text-sm text-g-danger">{errors.password}</p>}
          </div>

          <div>
            <label htmlFor={passwordConfirmationId} className="${FIELD_LABEL_CLASS}">
              Confirm password
            </label>
            <input
              id={passwordConfirmationId}
              type="password"
              value={form.data.passwordConfirmation}
              onChange={(event) => form.setData('passwordConfirmation', event.target.value)}
              required
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {errors.passwordConfirmation && (
              <p className="mt-1 text-sm text-g-danger">{errors.passwordConfirmation}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="${PRIMARY_SUBMIT_CLASS}"
          >
            Create account
          </button>
        </form>
${buildOAuthButtonsTemplate(oauthProviders)}
        <p className="mt-6 text-center text-sm text-g-text-2">
          Already have an account?{' '}
          <Link href="/login" className="text-g-accent-text transition hover:underline">
            Sign in
          </Link>
        </p>
      </section>
    </Layout>
  )
}
`
}

function buildProfileViewTemplate({ includePassword, providerOwnedEmail }: AuthFeatures): string {
  const errorFields = providerOwnedEmail
    ? includePassword
      ? `'name' | 'password'`
      : `'name'`
    : includePassword
      ? `'name' | 'email' | 'password'`
      : `'name' | 'email'`
  const emailFormField = providerOwnedEmail
    ? ''
    : `
  email: string`
  const emailFormValue = providerOwnedEmail
    ? ''
    : `
    email: profile.email,`
  const emailInput = providerOwnedEmail
    ? `
          <div>
            <label className="${FIELD_LABEL_CLASS}">Email</label>
            <p className="mt-1 w-full rounded-g-ctl border border-g-line bg-g-raised px-3 py-2 text-g-muted">
              {profile.email}
            </p>
            <p className="mt-1 text-xs text-g-muted">Managed by your sign-in provider.</p>
          </div>`
    : `
          <div>
            <label className="${FIELD_LABEL_CLASS}">Email</label>
            <input
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {form.errors.email ? <p className="mt-1 text-sm text-g-danger">{form.errors.email}</p> : null}
          </div>`
  const passwordFormField = includePassword
    ? `
  password: string`
    : ''
  const passwordFormValue = includePassword
    ? `
    password: '',`
    : ''
  const passwordInput = includePassword
    ? `
          <div>
            <label className="${FIELD_LABEL_CLASS}">New password</label>
            <input
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {form.errors.password ? <p className="mt-1 text-sm text-g-danger">{form.errors.password}</p> : null}
          </div>
`
    : ''
  const description = includePassword
    ? 'Update your account details and password.'
    : 'Update your account details.'

  return `import { Head, useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import Layout from '../../components/Layout.js'
import type { ValidationErrors } from '@guren/core'

interface Props {
  profile: { name: string; email: string }
  errors?: ValidationErrors<${errorFields}>
  status?: string
}

type ProfileFormValues = {
  name: string${emailFormField}${passwordFormField}
}

export default function ProfileEdit({ profile, status }: Props) {
  const form = useForm<ProfileFormValues>({
    name: profile.name,${emailFormValue}${passwordFormValue}
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    form.put('/profile')
  }

  return (
    <Layout>
      <Head title="Profile" />
      <section className="space-y-6 rounded-g-card border border-g-line bg-g-panel p-8 shadow-g-card">
        <header>
          ${tickHeading('Profile', '          ')}
          <p className="mt-2 text-sm text-g-text-2">${description}</p>
        </header>

        {status ? (
          ${calloutRow('ok', '{status}', '          ', { flush: true })}
        ) : null}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="${FIELD_LABEL_CLASS}">Name</label>
            <input
              type="text"
              value={form.data.name}
              onChange={(event) => form.setData('name', event.target.value)}
              className="mt-1 ${FORM_INPUT_CLASS}"
            />
            {form.errors.name ? <p className="mt-1 text-sm text-g-danger">{form.errors.name}</p> : null}
          </div>
${emailInput}
${passwordInput}
          <button
            type="submit"
            disabled={form.processing}
            className="${PRIMARY_SUBMIT_CLASS}"
          >
            Save changes
          </button>
        </form>
      </section>
    </Layout>
  )
}
`
}

function buildRoutesTemplate({
  includeExtras,
  includeVerify,
  includePassword,
  oauthProviders,
}: AuthFeatures): string {
  const includeOAuth = oauthProviders.length > 0
  const registerImport = includeExtras
    ? `\nimport RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'`
    : ''
  const registerRoutes = includeExtras
    ? `
  router.get('/register', [RegisterController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('register')
  router.post('/register', [RegisterController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('register.store')
`
    : ''

  const resetImport = includeExtras
    ? `\nimport ForgotPasswordController from '../app/Http/Controllers/Auth/ForgotPasswordController.js'\nimport ResetPasswordController from '../app/Http/Controllers/Auth/ResetPasswordController.js'`
    : ''
  const resetRoutes = includeExtras
    ? `
  router.get('/forgot-password', [ForgotPasswordController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('forgot-password')
  router.post('/forgot-password', [ForgotPasswordController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('forgot-password.store')
  router.get('/reset-password', [ResetPasswordController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('reset-password')
  router.post('/reset-password', [ResetPasswordController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('reset-password.store')
`
    : ''

  const verifyImport = includeVerify
    ? `\nimport VerifyEmailController from '../app/Http/Controllers/Auth/VerifyEmailController.js'`
    : ''
  const verifyRoutes = includeVerify
    ? `
  router.get('/verify-email', [VerifyEmailController, 'notice'], requireAuthenticated({ redirectTo: '/login' })).name('verify-email')
  router.post('/verify-email', [VerifyEmailController, 'resend'], requireAuthenticated({ redirectTo: '/login' })).name('verify-email.resend')
  // Public: confirm() validates the signed token itself and doesn't use the
  // session — gating it behind auth would strand a user who opens the email
  // link from a different device or after their session expired.
  router.get('/verify-email/confirm', [VerifyEmailController, 'confirm']).name('verify-email.confirm')
`
    : ''
  const requireVerifiedImport = includeVerify ? ', requireVerifiedEmail' : ''
  const dashboardMiddleware = includeVerify
    ? `requireAuthenticated({ redirectTo: '/login' }), requireVerifiedEmail({ redirectTo: '/verify-email' })`
    : `requireAuthenticated({ redirectTo: '/login' })`

  const oauthImport = includeOAuth
    ? `\nimport OAuthController from '../app/Http/Controllers/Auth/OAuthController.js'`
    : ''
  const oauthRoutes = includeOAuth
    ? `
  router.get('/auth/:provider', [OAuthController, 'redirectToProvider'], requireGuest({ redirectTo: '/dashboard' })).name('oauth.redirect')
  router.get('/auth/:provider/callback', [OAuthController, 'callback']).name('oauth.callback')
`
    : ''

  // Passwordless apps expose /login only as the OAuth button page — there is
  // no credential exchange to POST to.
  const loginStoreRoute = includePassword
    ? `\n  router.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('login.store')`
    : ''

  return `import { Router, requireAuthenticated, requireGuest${requireVerifiedImport} } from '@guren/core'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'${registerImport}${resetImport}${verifyImport}${oauthImport}
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'

export function registerAuthRoutes(router: Router): void {
  router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')${loginStoreRoute}
  router.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')
${registerRoutes}${resetRoutes}${verifyRoutes}${oauthRoutes}
  router.get('/dashboard', [DashboardController, 'index'], ${dashboardMiddleware}).name('dashboard')
  router.get('/profile', [ProfileController, 'edit'], requireAuthenticated({ redirectTo: '/login' })).name('profile.edit')
  router.put('/profile', [ProfileController, 'update'], requireAuthenticated({ redirectTo: '/login' })).name('profile.update')
}
`
}

/**
 * Re-running the seeder must not fail on the unique email. MySQL has no
 * ON CONFLICT clause — drizzle exposes INSERT ... ON DUPLICATE KEY UPDATE
 * instead, and calling `.onConflictDoNothing()` on a MySQL query builder
 * throws at runtime ("is not a function").
 */
function buildSeederTemplate(dialect: SchemaDialect): string {
  const idempotentInsert =
    dialect === 'mysql'
      ? `.onDuplicateKeyUpdate({ set: { name: 'Demo User' } })`
      : `.onConflictDoNothing({ target: users.email })`

  const context = seederContextTypes[dialect]

  return `import { defineSeeder, Hash, type ${context} } from '@guren/core'
import { users } from '../schema.js'

export default defineSeeder(async ({ db }: ${context}) => {
  const hasher = new Hash()
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
    ${idempotentInsert}
})
`
}

// These timestamps hold instants, so pg gets `timestamptz`: an offset-less
// column would take `defaultNow()` in the database session's zone while the
// app reads it back as UTC.
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
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

const emailVerifiedAtField: Record<SchemaDialect, string> = {
  sqlite: `emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp' }),`,
  pg: `emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),`,
  mysql: `emailVerifiedAt: timestamp('email_verified_at'),`,
}

function oauthIdFieldLine(provider: string, dialect: SchemaDialect): string {
  const camel = `${provider}Id`
  const snake = `${provider}_id`
  if (dialect === 'mysql') {
    return `${camel}: varchar('${snake}', { length: 255 }).unique(),`
  }
  return `${camel}: text('${snake}').unique(),`
}

function ensureAuthColumnImports(content: string, dialect: SchemaDialect): string {
  if (dialect === 'sqlite') {
    return ensureSqliteImports(content, ['sqliteTable', 'integer', 'text'])
  }
  if (dialect === 'mysql') {
    return ensureMysqlImports(content, ['mysqlTable', 'int', 'varchar', 'timestamp'])
  }
  return ensurePgImports(content, ['pgTable', 'serial', 'text', 'timestamp'])
}

/**
 * Splices columns after `rememberToken`, preserving its indentation. One rule
 * for both the fresh table block and an existing one, so no full table-block
 * variant has to be hand-maintained per feature combination.
 */
function insertColumnsAfterRememberToken(content: string, fieldLines: string[]): string | null {
  if (fieldLines.length === 0) {
    return content
  }

  const rememberTokenPattern = /^([ \t]*)rememberToken:[^\n]*\n/m
  let inserted = false

  const updated = content.replace(rememberTokenPattern, (line, indent: string) => {
    inserted = true
    const insertion = fieldLines.map((fieldLine) => `${indent}${fieldLine}\n`).join('')
    return `${line}${insertion}`
  })

  return inserted ? updated : null
}

// Anchored on `})` at line start to avoid premature matching inside nested
// function calls like `$defaultFn(() => ...)`.
const usersTablePattern = /export const users = (?:pgTable|sqliteTable|mysqlTable)\('users',\s*\{[\s\S]*?\n\}\)\s*\n?/

/**
 * OAuth accounts are passwordless, so the column must accept NULL — including
 * on a pre-existing table, which `--oauth` would otherwise hit with a NOT NULL
 * violation at the first signup. Scoped to the users table so a same-named
 * column elsewhere is untouched, and line-anchored so an argument list with
 * commas (mysql `varchar('password_hash', { length: 255 })`) still matches.
 */
function relaxPasswordHashForOAuth(content: string): string {
  const tableMatch = content.match(usersTablePattern)
  const target = tableMatch ? tableMatch[0] : content
  const relaxed = target.replace(/^([ \t]*passwordHash:[^\n]*?)\.notNull\(\)/m, '$1')
  if (relaxed === target) {
    return content
  }
  return tableMatch ? content.replace(target, relaxed) : relaxed
}

async function updateSchema({ includeVerify, includePassword, oauthProviders }: AuthFeatures): Promise<void> {
  const schemaPath = resolve(process.cwd(), 'db/schema.ts')
  const existing = await readIfExists(process.cwd(), 'db/schema.ts')

  if (existing === null) {
    return
  }

  let content = existing
  const originalContent = content
  const hasAuthColumns = content.includes('passwordHash')
  const dialect = detectSchemaDialect(content)

  if (hasAuthColumns) {
    // The table already has auth columns and may have been customized since —
    // extra columns, a trailing index callback. Rather than mangle a shape
    // this cannot fully parse, only the new columns are spliced in.
    if (oauthProviders.length > 0) {
      const relaxed = relaxPasswordHashForOAuth(content)
      if (relaxed !== content) {
        content = relaxed
        consola.info(
          'Made users.passwordHash nullable so OAuth accounts can be passwordless — '
            + (includePassword
              ? 'password-registered rows lose the NOT NULL guard.'
              : 'this scaffold no longer serves password login, so existing password rows can only sign in through a provider.'),
        )
      }
    }

    const missingColumns: Array<{ name: string; line: string }> = []
    if (includeVerify && !content.includes('emailVerifiedAt')) {
      missingColumns.push({ name: 'emailVerifiedAt', line: emailVerifiedAtField[dialect] })
    }
    for (const provider of oauthProviders) {
      const name = `${provider}Id`
      if (!content.includes(name)) {
        missingColumns.push({ name, line: oauthIdFieldLine(provider, dialect) })
      }
    }

    if (missingColumns.length === 0) {
      if (content !== originalContent) {
        await writeFile(schemaPath, content, 'utf8')
      }
      return
    }

    const updated = insertColumnsAfterRememberToken(content, missingColumns.map((c) => c.line))

    if (!updated) {
      consola.warn(
        `Could not locate the rememberToken column in db/schema.ts — add ${missingColumns.map((c) => c.name).join(', ')} to your users table manually.`,
      )
      if (content !== originalContent) {
        await writeFile(schemaPath, content, 'utf8')
      }
      return
    }

    content = ensureAuthColumnImports(updated, dialect)

    await writeFile(schemaPath, content, 'utf8')
    consola.info(`Added ${missingColumns.map((c) => c.name).join(', ')} column(s) to db/schema.ts (${dialect}).`)
    return
  }

  content = ensureAuthColumnImports(content, dialect)

  // Replace an existing users table that lacks auth columns, or append if
  // absent (usersTablePattern is shared with relaxPasswordHashForOAuth).
  const freshFieldLines: string[] = []
  if (includeVerify) {
    freshFieldLines.push(emailVerifiedAtField[dialect])
  }
  for (const provider of oauthProviders) {
    freshFieldLines.push(oauthIdFieldLine(provider, dialect))
  }

  const usersTableBlock = freshFieldLines.length > 0
    ? insertColumnsAfterRememberToken(usersTableBlocks[dialect], freshFieldLines)!
    : usersTableBlocks[dialect]

  if (usersTablePattern.test(content)) {
    content = content.replace(usersTablePattern, usersTableBlock)
  } else {
    content = `${content.trimEnd()}\n\n${usersTableBlock}`
  }

  if (oauthProviders.length > 0) {
    content = relaxPasswordHashForOAuth(content)
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

/**
 * Every file only the password experience needs. Re-running with
 * `--oauth-only` reports these rather than deleting files this run did not
 * write — the rewritten routes/auth.ts makes the controllers unreachable, but
 * `db/seeders/UsersSeeder.ts` is discovered by `db:seed` rather than routed,
 * so it would still insert an account with no way to sign in.
 */
const PASSWORD_SCAFFOLD_PATHS = [
  'app/Http/Validators/LoginValidator.ts',
  'db/seeders/UsersSeeder.ts',
  'app/Http/Controllers/Auth/RegisterController.ts',
  'app/Http/Controllers/Auth/ForgotPasswordController.ts',
  'app/Http/Controllers/Auth/ResetPasswordController.ts',
  'app/Http/Controllers/Auth/VerifyEmailController.ts',
  'app/Http/Validators/RegisterValidator.ts',
  'app/Http/Validators/ForgotPasswordValidator.ts',
  'app/Http/Validators/ResetPasswordValidator.ts',
  'resources/js/pages/auth/Register.tsx',
  'resources/js/pages/auth/ForgotPassword.tsx',
  'resources/js/pages/auth/ResetPassword.tsx',
  'resources/js/pages/auth/VerifyEmail.tsx',
  'app/Auth/AppUrl.ts',
  'app/Auth/PasswordResetStore.ts',
  'app/Auth/EmailVerificationStore.ts',
  'app/Mail/PasswordResetMail.ts',
  'app/Mail/EmailVerificationMail.ts',
  'app/Providers/MailProvider.ts',
  'config/mail.ts',
]

const MAIL_SCAFFOLD_PATHS = ['app/Providers/MailProvider.ts', 'config/mail.ts']

async function warnAboutStalePasswordScaffold(): Promise<void> {
  const { existsSync } = await import('node:fs')
  const leftovers = PASSWORD_SCAFFOLD_PATHS.filter((path) => existsSync(resolve(process.cwd(), path)))

  if (leftovers.length === 0) {
    return
  }

  consola.warn(
    `These files from an earlier make:auth run serve password login only and are no longer wired into routes/auth.ts — delete them: ${leftovers.join(', ')}`,
  )
  if (leftovers.includes('db/seeders/UsersSeeder.ts')) {
    consola.warn(
      'db/seeders/UsersSeeder.ts still runs on `db:seed` and would insert a password account that cannot sign in.',
    )
  }
  if (leftovers.some((path) => MAIL_SCAFFOLD_PATHS.includes(path))) {
    consola.warn(
      'Your app entry may still register MailProvider and CoreMailServiceProvider from that run — remove them too if nothing else sends mail.',
    )
  }
}

const KNOWN_OAUTH_PROVIDERS = ['github', 'google', 'discord'] as const

function parseOAuthProviders(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }

  const seen = new Set<string>()
  for (const token of raw.split(',')) {
    const name = token.trim().toLowerCase()
    if (!name) {
      continue
    }
    if (!(KNOWN_OAUTH_PROVIDERS as readonly string[]).includes(name)) {
      consola.warn(`Unknown OAuth provider "${name}" — skipping. Supported: ${KNOWN_OAUTH_PROVIDERS.join(', ')}.`)
      continue
    }
    seen.add(name)
  }

  return Array.from(seen)
}

export interface MakeAuthOptions extends WriterOptions {
  install?: boolean
  /** Skip registration and password reset scaffolding and generate the login-only experience. */
  minimal?: boolean
  /** Also scaffold email verification. Requires the default (non-minimal) experience. */
  verify?: boolean
  /** Also scaffold OAuth login buttons. Comma-separated provider names (github, google, discord). */
  oauth?: string
  /** Scaffold OAuth as the only sign-in method: no password login, registration, or reset. Requires `oauth`. */
  oauthOnly?: boolean
}

/**
 * What the scaffold will contain, derived once from the raw options.
 * Everything downstream consumes these capabilities rather than the flags, so
 * a new way to switch one off lands in `resolveAuthFeatures()` alone.
 */
interface AuthFeatures {
  /** Registration and password reset, plus the mail wiring they need. */
  includeExtras: boolean
  /** Email verification. Builds on the registration flow. */
  includeVerify: boolean
  /** Password credentials: POST /login, the login validator, password fields, the demo seeder. */
  includePassword: boolean
  /** The email comes from the OAuth provider and must not be locally editable. */
  providerOwnedEmail: boolean
  /** Every account is created with a password, so the user model can require one. */
  passwordOnlySignUp: boolean
  /** Providers to scaffold buttons, a callback, and id columns for. */
  oauthProviders: string[]
}

function resolveAuthFeatures(options: MakeAuthOptions): AuthFeatures {
  const oauthProviders = parseOAuthProviders(options.oauth)
  const oauthOnly = Boolean(options.oauthOnly)

  // Neither degraded reading is defensible: honouring `--oauth-only` without
  // providers scaffolds an app with no way to sign in, ignoring it scaffolds
  // the password experience the flag exists to opt out of.
  if (oauthOnly && oauthProviders.length === 0) {
    throw new Error(
      `--oauth-only requires --oauth with at least one supported provider (${KNOWN_OAUTH_PROVIDERS.join(', ')}).`,
    )
  }

  // Password login is the substrate registration, reset, and the profile
  // password field all sit on, so --oauth-only subsumes --minimal.
  const includeExtras = !options.minimal && !oauthOnly
  const includeVerify = includeExtras && Boolean(options.verify)

  if (options.verify && !includeExtras) {
    consola.warn(
      oauthOnly
        ? '--verify has nothing to verify without password registration — skipping (OAuth accounts arrive with a provider-vouched email).'
        : '--verify requires the default (non-minimal) experience — skipping email verification.',
    )
  }

  // Without --verify nothing in the scaffold can re-prove a replacement
  // address, so the profile form must not accept one.
  const providerOwnedEmail = oauthProviders.length > 0 && !includeVerify

  // OAuth accounts are created passwordless, so the user model can only
  // require a password when no provider can produce an account without one.
  const passwordOnlySignUp = !oauthOnly && oauthProviders.length === 0

  return {
    includeExtras,
    includeVerify,
    includePassword: !oauthOnly,
    providerOwnedEmail,
    passwordOnlySignUp,
    oauthProviders,
  }
}

export async function makeAuth(options: MakeAuthOptions = {}): Promise<string[]> {
  assertCwdUnsupported(options, 'make:auth')

  // Every variant is Inertia-shaped, and the refusal must precede the schema
  // patch and the migration as well as the first write: a run stopped halfway
  // through those is harder to undo than one that never started.
  await assertNotApiOnly(process.cwd(), {
    does: 'The auth scaffold renders Inertia sign-in pages',
    instead: 'Guard routes/api.ts with createBearerTokenMiddleware from @guren/core instead',
  })

  const features = resolveAuthFeatures(options)
  const { includeExtras, includeVerify, includePassword, passwordOnlySignUp, oauthProviders } = features
  const includeOAuth = oauthProviders.length > 0

  const files = [
    { path: 'app/Http/Controllers/Auth/LoginController.ts', contents: buildLoginControllerTemplate(includePassword) },
    authFile('app/Http/Controllers/DashboardController.ts'),
    { path: 'app/Http/Controllers/ProfileController.ts', contents: buildProfileControllerTemplate(features) },
    { path: 'app/Models/User.ts', contents: buildUserModelTemplate(passwordOnlySignUp) },
    authFile('app/Providers/AuthProvider.ts'),
    { path: 'app/Http/Validators/ProfileValidator.ts', contents: buildProfileValidatorTemplate(features) },
    authFile('resources/js/components/Layout.tsx'),
    {
      path: 'resources/js/pages/auth/Login.tsx',
      contents: includePassword
        ? buildLoginViewTemplate(includeExtras, includeExtras, oauthProviders)
        : buildOAuthOnlyLoginViewTemplate(oauthProviders),
    },
    authFile('resources/js/pages/dashboard/Index.tsx'),
    { path: 'resources/js/pages/profile/Edit.tsx', contents: buildProfileViewTemplate(features) },
    { path: 'routes/auth.ts', contents: buildRoutesTemplate(features) },
  ]

  if (includePassword) {
    files.push(
      authFile('app/Http/Validators/LoginValidator.ts'),
      // Without password login the demo user is an unreachable row, and
      // seeding it would hash with scrypt — the cost --oauth-only avoids. The
      // only dialect-sensitive file here, hence the late schema read.
      { path: 'db/seeders/UsersSeeder.ts', contents: buildSeederTemplate(await readSchemaDialect()) },
    )
  }

  if (includeExtras) {
    files.push(
      // Every flow that mails an absolute link routes through this, so that
      // none of them build one from the request host.
      authFile('app/Auth/AppUrl.ts'),
      { path: 'app/Http/Controllers/Auth/RegisterController.ts', contents: buildRegisterControllerTemplate(includeVerify) },
      authFile('app/Http/Validators/RegisterValidator.ts'),
      { path: 'resources/js/pages/auth/Register.tsx', contents: buildRegisterViewTemplate(oauthProviders) },
      authFile('app/Http/Controllers/Auth/ForgotPasswordController.ts'),
      authFile('app/Http/Controllers/Auth/ResetPasswordController.ts'),
      authFile('app/Http/Validators/ForgotPasswordValidator.ts'),
      authFile('app/Http/Validators/ResetPasswordValidator.ts'),
      authFile('resources/js/pages/auth/ForgotPassword.tsx'),
      authFile('resources/js/pages/auth/ResetPassword.tsx'),
      authFile('app/Auth/PasswordResetStore.ts'),
      authFile('app/Mail/PasswordResetMail.ts'),
      authFile('app/Providers/MailProvider.ts'),
      authFile('config/mail.ts'),
    )
  }

  if (includeVerify) {
    files.push(
      authFile('app/Http/Controllers/Auth/VerifyEmailController.ts'),
      authFile('resources/js/pages/auth/VerifyEmail.tsx'),
      authFile('app/Auth/EmailVerificationStore.ts'),
      authFile('app/Mail/EmailVerificationMail.ts'),
    )
  }

  if (includeOAuth) {
    files.push(
      { path: 'app/Providers/OAuthProvider.ts', contents: buildOAuthProviderTemplate(oauthProviders) },
      { path: 'app/Http/Controllers/Auth/OAuthController.ts', contents: buildOAuthControllerTemplate(oauthProviders, includeVerify) },
    )
  }

  const created = await writeScaffoldFiles(files, options)

  // The pages above style with Guren UI tokens (bg-g-page, …).
  await ensureGurenUiTokens()

  await updateSchema(features)
  if (!includePassword) {
    await warnAboutStalePasswordScaffold()
  }
  const migrationGenerated = await generateUsersMigration()

  if (options.install) {
    await installAuth(features, migrationGenerated)
  } else {
    consola.info('Next steps:')
    consola.info('  • Register AuthProvider in your createApp() providers array')
    consola.info('  • Enable sessions and CSRF by adding `auth: {}` to your createApp() options')
    consola.info('  • Import registerAuthRoutes from routes/auth.ts and call it from your routes/web.ts registrar')
    if (includeExtras) {
      consola.info('  • Register MailProvider in your createApp() providers array (used to send password reset emails)')
      consola.info('  • Set APP_URL in your .env to the public base URL of this app — emailed links are built from it, and production refuses to send without it')
    }
    if (!migrationGenerated) {
      consola.info('  • Run `bun run db:make` to generate the users migration')
    }
    consola.info(includePassword ? '  • Run `bun run db:migrate` and `bun run db:seed`' : '  • Run `bun run db:migrate`')
    consola.info('  • Install zod if not already installed: `bun add zod`')
    if (includeOAuth) {
      consola.info('  • Register CoreOAuthServiceProvider (from @guren/core) and OAuthProvider in your createApp() providers array')
      for (const provider of oauthProviders) {
        const upper = provider.toUpperCase()
        consola.info(`  • Set OAUTH_${upper}_CLIENT_ID / OAUTH_${upper}_CLIENT_SECRET / OAUTH_${upper}_REDIRECT_URI in your .env (see .env.example)`)
      }
    }
  }

  return created
}

async function installAuth(
  { includeExtras, includePassword, oauthProviders }: AuthFeatures,
  migrationGenerated: boolean,
): Promise<void> {
  consola.info('Installing authentication configuration...')

  const appPath = await resolveAppEntry()

  if (!appPath) {
    consola.warn(`Could not find ${APP_ENTRY_CANDIDATES.join(' or ')} - skipping auto-configuration`)
    consola.info('Please manually register AuthProvider in your Application providers')
    return
  }

  const wiring = { appPath, verbose: true } as const

  await wireAppProvider('AuthProvider', wiring)

  if (includeExtras) {
    // Core's provider goes before MailProvider (the `guren add mail`
    // convention) so `'mail'` resolves to the configured manager rather than
    // Core's empty-config default, whichever order the two commands run in.
    await wireProvider(
      'CoreMailServiceProvider',
      "import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'",
      wiring,
    )
    await wireAppProvider('MailProvider', wiring)
  }

  if (oauthProviders.length > 0) {
    await wireProvider(
      'CoreOAuthServiceProvider',
      "import { OAuthServiceProvider as CoreOAuthServiceProvider } from '@guren/core'",
      wiring,
    )
    await wireAppProvider('OAuthProvider', wiring)
  }

  // Enable session + CSRF middleware: AuthServiceProvider is only registered
  // when createApp() receives an `auth` option.
  const authOptionResult = await addCreateAppOption(appPath, 'auth', '{}')
  if (authOptionResult.modified) {
    consola.success(`Enabled sessions and CSRF via auth option in ${appPath}`)
  } else if (authOptionResult.reason === PATCH_REASONS.optionAlreadySet) {
    consola.info(`auth option already set in ${appPath}`)
  } else {
    consola.warn(`Could not set the auth option automatically: ${authOptionResult.reason}`)
    consola.info('Add `auth: {}` to your createApp() options to enable sessions and CSRF.')
  }

  await wireRouteRegistrar('registerAuthRoutes', "import { registerAuthRoutes } from './auth.js'")

  consola.success('Authentication configuration installed!')
  consola.info('Session middleware is auto-configured via AuthServiceProvider (autoSession: true)')
  consola.info('Next steps:')
  if (!migrationGenerated) {
    consola.info('  • Run `bun run db:make` to generate the users migration')
  }
  consola.info('  • Run `bun run db:migrate` to create the users table')
  if (includePassword) {
    consola.info('  • Run `bun run db:seed` to create demo user')
    consola.info('  • Start the dev server and visit /login (demo@example.com / secret)')
  } else {
    consola.info('  • Start the dev server and visit /login — the first provider sign-in creates the account')
  }
  for (const provider of oauthProviders) {
    const upper = provider.toUpperCase()
    consola.info(`  • Set OAUTH_${upper}_CLIENT_ID / OAUTH_${upper}_CLIENT_SECRET / OAUTH_${upper}_REDIRECT_URI in your .env (see .env.example)`)
  }
}
