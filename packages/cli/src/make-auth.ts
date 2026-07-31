import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep as pathSep } from 'node:path'
import { consola } from 'consola'
import { writeFilesSafe, type WriterOptions } from './utils'
import {
  addImport,
  addProvider,
  addCreateAppOption,
  detectSchemaDialect,
  ensureDrizzleImports,
  ensureMysqlImports,
  ensureSqliteImports,
  readSchemaDialect,
  type SchemaDialect,
} from './patch-helpers'
import { readIfExists } from './discovery'
import { makeMigration } from './make-migration'

// Passwordless apps keep show() (the OAuth button page) and destroy()
// (logout) but have no credential exchange at all — there is no POST /login
// route pointing at store(), so scaffolding it would leave a dead action that
// still pulls in the password validator.
function buildLoginControllerTemplate(includePassword: boolean): string {
  const coreImports = includePassword ? 'Controller, ValidationException' : 'Controller'
  const validatorImport = includePassword
    ? `\nimport { LoginSchema } from '../../Validators/LoginValidator.js'`
    : ''

  const showBody = includePassword
    ? `    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.Login, { email }, { url: this.request.path, title: 'Login' })`
    : `    return this.inertia(pages.auth.Login, {}, { url: this.request.path, title: 'Login' })`

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
import { sendEmailVerificationMail } from '../../../Mail/EmailVerificationMail.js'`
    : ''

  const sendVerification = includeVerify
    ? `
    const { token } = await createEmailVerificationToken(user.email, emailVerificationStore)
    const verifyUrl = buildVerificationUrl(\`\${new URL(this.request.url).origin}/verify-email/confirm\`, token, user.email)
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
${sendVerification}
    this.auth.session()?.regenerate()
    await this.auth.login(user)

    return this.redirect('${redirectPath}')
  }
}
`
}

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
    // account exists, to avoid leaking which emails are registered. The
    // mail send is deliberately not awaited: the transport round-trip only
    // happens for known accounts, so awaiting it would let response timing
    // (or a transport failure) reveal which emails exist.
    const [user] = await User.where({ email })
    if (user) {
      const { token } = await createPasswordResetToken(email, passwordResetStore)
      const resetUrl = buildPasswordResetUrl(\`\${new URL(this.request.url).origin}/reset-password\`, token, email)
      void sendPasswordResetMail(this.make('mail'), email, resetUrl).catch((error) => {
        console.error('Failed to send password reset email:', error)
      })
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

const verifyEmailControllerTemplate = `import { Controller, createEmailVerificationToken, completeEmailVerification, buildVerificationUrl } from '@guren/core'
import { User, type UserRecord } from '../../../Models/User.js'
import { emailVerificationStore } from '../../../Auth/EmailVerificationStore.js'
import { sendEmailVerificationMail } from '../../../Mail/EmailVerificationMail.js'
import { pages } from '@/.guren/pages.gen'

const EXPIRED_MESSAGE = 'This verification link is invalid or has expired. Request a new one below.'

export default class VerifyEmailController extends Controller {
  async notice(): Promise<Response> {
    const user = await this.auth.userOrFail<UserRecord>()
    if (user.emailVerifiedAt) {
      return this.redirect('/dashboard')
    }

    return this.inertia(pages.auth.VerifyEmail, {}, { url: this.request.path, title: 'Verify email' })
  }

  async resend(): Promise<Response> {
    const user = await this.auth.userOrFail<UserRecord>()

    if (!user.emailVerifiedAt) {
      const { token } = await createEmailVerificationToken(user.email, emailVerificationStore)
      const verifyUrl = buildVerificationUrl(\`\${new URL(this.request.url).origin}/verify-email/confirm\`, token, user.email)
      await sendEmailVerificationMail(this.make('mail'), user.email, verifyUrl)
    }

    return this.inertia(pages.auth.VerifyEmail, {
      status: 'A new verification link has been sent to your email address.',
    }, { url: this.request.path, title: 'Verify email' })
  }

  async confirm(): Promise<Response> {
    const token = this.request.query('token') ?? ''

    const verifiedEmail = await completeEmailVerification(token, emailVerificationStore, async (email) => {
      await User.update({ email }, { emailVerifiedAt: new Date() })
      return email
    })

    if (!verifiedEmail) {
      return this.inertia(pages.auth.VerifyEmail, { status: EXPIRED_MESSAGE }, {
        url: this.request.path,
        title: 'Verify email',
      })
    }

    return this.redirect('/dashboard')
  }
}
`

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

  // Matches the wiring convention scaffolded by `guren add oauth`: providers
  // are registered against the shared `oauth` singleton (bound by
  // CoreOAuthServiceProvider) and only when all three env vars are set. The
  // login buttons still render either way — but clicking one fails fast with
  // a clear "provider not configured" error app-side, instead of redirecting
  // to the provider with empty credentials and failing confusingly there.
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

  // The provider already vouches for this address, so an OAuth-created
  // account is verified on arrival — without this, requireVerifiedEmail
  // would strand OAuth users at /verify-email forever, since this
  // controller never sends a verification email for them to click.
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

    const { url } = await this.oauth().authorize(provider, {
      redirectTo: this.request.query('redirectTo') ?? undefined,
    })

    return this.redirect(url)
  }

  async callback(): Promise<Response> {
    const { provider } = this.validateParams(ProviderParamSchema)
    const { code, state } = this.validateQuery(CallbackQuerySchema)

    const { profile, redirectTo } = await this.oauth().handleCallback(provider, { code, state })

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

/**
 * When OAuth is the only way in, the stored email is a copy of what the
 * provider vouched for and the profile form must not be able to replace it:
 * an account could otherwise claim an address it has never proven, and
 * OAuthController's email-collision check would then reject the real owner's
 * first sign-in. Nothing re-verifies it here — `--verify` is unavailable in
 * this mode — so the only safe form is one that can't change it.
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
    }, { url: this.request.path, title: 'Profile' })
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
    }, { url: this.request.path, title: 'Profile' })
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
      const verifyUrl = buildVerificationUrl(\`\${new URL(this.request.url).origin}/verify-email/confirm\`, token, email)
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
    }, { url: this.request.path, title: 'Profile' })
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
    }, { url: this.request.path, title: 'Profile' })
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
}) {
  // passwordHash and rememberToken are denied from mass assignment by
  // AuthenticatableModel itself — no per-model configuration needed.

  // Never serialized by Model.serialize() and stripped from auth.user()
  static override hidden = ['passwordHash', 'rememberToken']
}
`
}

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

// Swap for a Redis-backed store (see @guren/core/redis) in production
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

const emailVerificationStoreTemplate = `import { MemoryEmailVerificationStore } from '@guren/core'

// Swap for a Redis-backed store (see @guren/core/redis) in production
// or any multi-instance deployment — this in-memory store does not
// survive restarts and is not shared across processes.
export const emailVerificationStore = new MemoryEmailVerificationStore()
`

const emailVerificationMailTemplate = `import { mail, type MailManager } from '@guren/core'

export async function sendEmailVerificationMail(manager: MailManager, email: string, verifyUrl: string): Promise<void> {
  await mail(manager)
    .to(email)
    .subject('Verify your email address')
    .html(\`
      <h1>Verify your email address</h1>
      <p>Click the link below to verify your email address.</p>
      <p><a href="\${verifyUrl}">\${verifyUrl}</a></p>
      <p>If you didn't create an account, you can safely ignore this email.</p>
    \`)
    .text(\`
Verify your email address

Click the link below to verify your email address.

\${verifyUrl}

If you didn't create an account, you can safely ignore this email.
    \`)
    .send()
}
`

const loginValidatorTemplate = `import { z } from 'zod'

export const LoginSchema = z.object({
  // Lowercased to match how registration stores emails — a case-sensitive
  // lookup would otherwise reject the same address typed with different casing.
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .email('The email address is badly formatted.')
    .toLowerCase(),
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
    // Lowercased so it round-trips correctly through the password-reset and
    // email-verification token helpers, which normalize emails to lowercase
    // internally before matching against stored records.
    email: z
      .string()
      .trim()
      .min(1, 'Email is required.')
      .email('The email address is badly formatted.')
      .toLowerCase(),
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
  // Lowercased to match how registration stores emails and how the
  // password-reset token helpers normalize emails internally.
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .email('The email address is badly formatted.')
    .toLowerCase(),
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
    .email('Enter a valid email address.')
    .toLowerCase(),`

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

const layoutTemplate = `import { Link, usePage } from '@inertiajs/react'
import type { PropsWithChildren } from 'react'

export default function Layout({ children }: PropsWithChildren) {
  const { props } = usePage<{ auth?: { user?: { name?: string } } }>()
  const user = props.auth?.user
  const navButtonClass =
    'rounded border border-emerald-500 px-3 py-1 text-emerald-200 transition hover:bg-emerald-500 hover:text-slate-950'

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
              // Inertia's HTTP client copies the XSRF-TOKEN cookie into the
              // request header. A native <form> does not, so CSRF protection
              // would answer 403 and leave the session signed in.
              <Link href="/logout" method="post" as="button" className={navButtonClass}>
                Log out
              </Link>
            ) : (
              <Link href="/login" className={navButtonClass}>
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
            className="flex w-full items-center justify-center rounded border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-medium text-slate-100 transition hover:border-emerald-400 hover:text-emerald-200"
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
          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-500">
            <span className="h-px flex-1 bg-slate-800" />
            Or continue with
            <span className="h-px flex-1 bg-slate-800" />
          </div>`
    : ''

  return `
        <div className="mt-6 space-y-3">${dividerBlock}
${buildOAuthButtonLinks(providers)}
        </div>`
}

/**
 * A separate template rather than more holes in buildLoginViewTemplate: the
 * convention in this file is to splice fragments in when a variant *adds or
 * drops fields*, and to write a second template when the component's
 * structure changes. Here the entire controlled form — useForm, useId, every
 * input, the submit button — is gone, so splicing would leave a builder whose
 * two outputs share little more than the card chrome.
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
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Sign in</h1>
        <p className="mt-2 text-sm text-slate-400">
          Choose a provider to continue.
        </p>

        {errors.message && (
          <p className="mt-4 rounded border border-rose-500/60 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
            {errors.message}
          </p>
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
${buildOAuthButtonsTemplate(oauthProviders)}
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
}

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

const verifyEmailViewTemplate = `import { Head, useForm } from '@inertiajs/react'
import Layout from '../../components/Layout.js'

interface Props {
  status?: string
}

export default function VerifyEmail({ status }: Props) {
  const form = useForm({})

  return (
    <Layout>
      <Head title="Verify email" />
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <h1 className="text-2xl font-semibold text-emerald-300">Verify your email</h1>
        <p className="mt-2 text-sm text-slate-400">
          We sent a verification link to your email address. Click it to activate your account.
        </p>

        {status ? (
          <p className="mt-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            {status}
          </p>
        ) : null}

        <form
          className="mt-6"
          onSubmit={(event) => {
            event.preventDefault()
            form.post('/verify-email')
          }}
        >
          <button
            type="submit"
            disabled={form.processing}
            className="w-full rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Resend verification email
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
            <label className="block text-sm font-medium text-slate-200">Email</label>
            <p className="mt-1 w-full rounded border border-slate-800 bg-slate-900 px-3 py-2 text-slate-400">
              {profile.email}
            </p>
            <p className="mt-1 text-xs text-slate-500">Managed by your sign-in provider.</p>
          </div>`
    : `
          <div>
            <label className="block text-sm font-medium text-slate-200">Email</label>
            <input
              type="email"
              value={form.data.email}
              onChange={(event) => form.setData('email', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.email ? <p className="mt-1 text-sm text-rose-300">{form.errors.email}</p> : null}
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
            <label className="block text-sm font-medium text-slate-200">New password</label>
            <input
              type="password"
              value={form.data.password}
              onChange={(event) => form.setData('password', event.target.value)}
              className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
            />
            {form.errors.password ? <p className="mt-1 text-sm text-rose-300">{form.errors.password}</p> : null}
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
      <section className="space-y-6 rounded-lg border border-slate-800 bg-slate-900/40 p-8 shadow-xl shadow-emerald-500/5">
        <header>
          <h1 className="text-2xl font-semibold text-emerald-300">Profile</h1>
          <p className="mt-2 text-sm text-slate-400">${description}</p>
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
${emailInput}
${passwordInput}
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

  return `import { defineSeeder, ScryptHasher } from '@guren/core'
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
    ${idempotentInsert}
})
`
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

const emailVerifiedAtField: Record<SchemaDialect, string> = {
  sqlite: `emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp' }),`,
  pg: `emailVerifiedAt: timestamp('email_verified_at', { withTimezone: false }),`,
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
  return ensureDrizzleImports(content, ['pgTable', 'serial', 'text', 'timestamp'])
}

/**
 * Insert one or more column definitions right after the `rememberToken`
 * column of a `users` table block, preserving its indentation. Used both to
 * build the "with verify/oauth" variant of a fresh table block and to patch
 * an existing one — a single source of truth for the splice, instead of
 * hand-maintaining full table-block template variants per feature
 * combination.
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
 * OAuth-created accounts are passwordless, so the users table must accept a
 * NULL password hash. Applies to both freshly written and pre-existing users
 * tables (adding --oauth to a password-auth app would otherwise hit a
 * NOT NULL violation on the first OAuth signup). Scoped to the users table
 * so a same-named column on another table is never touched, and
 * line-anchored so argument lists containing commas (mysql
 * `varchar('password_hash', { length: 255 })`) still match.
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
    // The users table already has auth columns (from an earlier make:auth
    // run) and may have been customized since — e.g. extra columns or a
    // trailing index callback (`pgTable('users', {...}, (table) => [...])`).
    // Rather than risk mangling a table shape we can't fully parse, insert
    // just the new columns next to the rememberToken column we know we
    // generated, preserving its indentation.
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

async function updatePageContracts(): Promise<void> {
}

/**
 * Every file only the password experience needs — login, registration, reset,
 * and the mail and email-verification wiring that exist to serve them.
 *
 * Files this run no longer scaffolds are omitted, never deleted, so
 * re-running an existing password app with `--oauth-only` leaves all of these
 * on disk. The rewritten routes/auth.ts makes the stale controllers
 * unreachable, but `db/seeders/UsersSeeder.ts` is discovered by `db:seed`
 * rather than routed, so it would still hash a password and insert an account
 * that has no way to sign in. Report what is left rather than deleting files
 * we did not write on this run.
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
      'src/app.ts may still register MailProvider and CoreMailServiceProvider from that run — remove them too if nothing else sends mail.',
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
 * What the scaffold is actually going to contain, derived once from the raw
 * options. Everything downstream — every template builder, the schema patch,
 * the install step — consumes these capabilities rather than the flags that
 * produced them, so a second way to switch a capability off lands in
 * resolveAuthFeatures() alone.
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

  // Neither degraded reading of `--oauth-only` without providers is
  // defensible: honouring it scaffolds an app with no way to sign in, and
  // ignoring it scaffolds the full password experience the flag exists to
  // opt out of.
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

  // An OAuth account's email is asserted by the provider. Without --verify,
  // nothing in the scaffold can re-prove a replacement, so the profile form
  // must not accept one — that covers --oauth-only (which always disables
  // --verify) as well as plain --oauth without --verify.
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
  const features = resolveAuthFeatures(options)
  const { includeExtras, includeVerify, includePassword, passwordOnlySignUp, oauthProviders } = features
  const includeOAuth = oauthProviders.length > 0

  const files = [
    { path: 'app/Http/Controllers/Auth/LoginController.ts', contents: buildLoginControllerTemplate(includePassword) },
    { path: 'app/Http/Controllers/DashboardController.ts', contents: dashboardControllerTemplate },
    { path: 'app/Http/Controllers/ProfileController.ts', contents: buildProfileControllerTemplate(features) },
    { path: 'app/Models/User.ts', contents: buildUserModelTemplate(passwordOnlySignUp) },
    { path: 'app/Providers/AuthProvider.ts', contents: authProviderTemplate },
    { path: 'app/Http/Validators/ProfileValidator.ts', contents: buildProfileValidatorTemplate(features) },
    { path: 'resources/js/components/Layout.tsx', contents: layoutTemplate },
    {
      path: 'resources/js/pages/auth/Login.tsx',
      contents: includePassword
        ? buildLoginViewTemplate(includeExtras, includeExtras, oauthProviders)
        : buildOAuthOnlyLoginViewTemplate(oauthProviders),
    },
    { path: 'resources/js/pages/dashboard/Index.tsx', contents: dashboardViewTemplate },
    { path: 'resources/js/pages/profile/Edit.tsx', contents: buildProfileViewTemplate(features) },
    { path: 'routes/auth.ts', contents: buildRoutesTemplate(features) },
  ]

  if (includePassword) {
    files.push(
      { path: 'app/Http/Validators/LoginValidator.ts', contents: loginValidatorTemplate },
      // The demo user only exists to be signed in as with a password. Without
      // password login it is an unreachable row — and seeding it would hash a
      // password with scrypt, the exact cost --oauth-only avoids. The seeder is
      // the only dialect-sensitive file here, so the schema is read only now.
      { path: 'db/seeders/UsersSeeder.ts', contents: buildSeederTemplate(await readSchemaDialect()) },
    )
  }

  if (includeExtras) {
    files.push(
      { path: 'app/Http/Controllers/Auth/RegisterController.ts', contents: buildRegisterControllerTemplate(includeVerify) },
      { path: 'app/Http/Validators/RegisterValidator.ts', contents: registerValidatorTemplate },
      { path: 'resources/js/pages/auth/Register.tsx', contents: buildRegisterViewTemplate(oauthProviders) },
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

  if (includeVerify) {
    files.push(
      { path: 'app/Http/Controllers/Auth/VerifyEmailController.ts', contents: verifyEmailControllerTemplate },
      { path: 'resources/js/pages/auth/VerifyEmail.tsx', contents: verifyEmailViewTemplate },
      { path: 'app/Auth/EmailVerificationStore.ts', contents: emailVerificationStoreTemplate },
      { path: 'app/Mail/EmailVerificationMail.ts', contents: emailVerificationMailTemplate },
    )
  }

  if (includeOAuth) {
    files.push(
      { path: 'app/Providers/OAuthProvider.ts', contents: buildOAuthProviderTemplate(oauthProviders) },
      { path: 'app/Http/Controllers/Auth/OAuthController.ts', contents: buildOAuthControllerTemplate(oauthProviders, includeVerify) },
    )
  }

  const created = await writeFilesSafe(files, options)

  await updateSchema(features)
  await updatePageContracts()
  if (!includePassword) {
    await warnAboutStalePasswordScaffold()
  }
  const migrationGenerated = await generateUsersMigration()

  if (options.install) {
    await installAuth(features, migrationGenerated)
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
    consola.info(includePassword ? '  • Run `bun run db:migrate` and `bun run db:seed`' : '  • Run `bun run db:migrate`')
    consola.info('  • Install zod if not already installed: `bun add zod`')
    if (includeOAuth) {
      consola.info('  • Register CoreOAuthServiceProvider (from @guren/core) and OAuthProvider in src/app.ts providers array')
      for (const provider of oauthProviders) {
        const upper = provider.toUpperCase()
        consola.info(`  • Set OAUTH_${upper}_CLIENT_ID / OAUTH_${upper}_CLIENT_SECRET / OAUTH_${upper}_REDIRECT_URI in your .env (see .env.example)`)
      }
    }
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

async function installAuth(
  { includeExtras, includePassword, oauthProviders }: AuthFeatures,
  migrationGenerated: boolean,
): Promise<void> {
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

  if (oauthProviders.length > 0) {
    const coreImportResult = await addImport(appPath, "import { OAuthServiceProvider as CoreOAuthServiceProvider } from '@guren/core'")
    if (coreImportResult.modified) {
      consola.success(`Added CoreOAuthServiceProvider import to ${appPath}`)
    }
    const coreProviderResult = await addProvider(appPath, 'CoreOAuthServiceProvider')
    if (coreProviderResult.modified) {
      consola.success(`Added CoreOAuthServiceProvider to providers array in ${appPath}`)
    } else if (coreProviderResult.reason !== 'Provider already registered') {
      consola.warn(`Could not add CoreOAuthServiceProvider: ${coreProviderResult.reason}`)
    }

    await wireProvider(appPath, 'OAuthProvider', 'app/Providers/OAuthProvider.js')
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
