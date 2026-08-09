import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { consola } from 'consola'
import { createTempWorkspace, MYSQL_SCHEMA_FIXTURE, PG_SCHEMA_FIXTURE, SQLITE_SCHEMA_FIXTURE } from './helpers'
import { makeAuth } from '../src/make-auth'

// Shared with packages/create-app/templates/blog/app/Providers/AuthProvider.ts,
// which ports this same boot() so the blog blueprint's Layout.tsx nav (also
// reading `props.auth.user`) doesn't render as a guest while signed in. Pinning
// both copies to this snippet is how the two are kept from silently drifting.
const SHARE_INERTIA_AUTH_PROPS_SNIPPET = `shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    })`

describe('makeAuth', () => {
  it('scaffolds auth resources and installs providers', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await mkdir(join(workspace.dir, 'db'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { createApp } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider],
})

export default app
`,
        'utf8',
      )

      await writeFile(
        join(workspace.dir, 'routes/web.ts'),
        `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}
`,
        'utf8',
      )

      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'resources/js/pages/Home.tsx'),
        `interface Props { message: string }\nexport default function Home({ message }: Props) { return <h1>{message}</h1> }\n`,
        'utf8',
      )

      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `export const posts = 'posts'
`,
        'utf8',
      )

      const created = await makeAuth({ install: true, force: true })

      expect(created).toHaveLength(27)
      expect(created).toEqual(expect.arrayContaining([
        expect.stringContaining('AppUrl.ts'),
        expect.stringContaining('LoginController.ts'),
        expect.stringContaining('routes/auth.ts'),
        expect.stringContaining('ProfileController.ts'),
        expect.stringContaining('ProfileValidator.ts'),
        expect.stringContaining('RegisterController.ts'),
        expect.stringContaining('RegisterValidator.ts'),
        expect.stringContaining('Register.tsx'),
        expect.stringContaining('ForgotPasswordController.ts'),
        expect.stringContaining('ResetPasswordController.ts'),
        expect.stringContaining('ForgotPasswordValidator.ts'),
        expect.stringContaining('ResetPasswordValidator.ts'),
        expect.stringContaining('ForgotPassword.tsx'),
        expect.stringContaining('ResetPassword.tsx'),
        expect.stringContaining('PasswordResetStore.ts'),
        expect.stringContaining('PasswordResetMail.ts'),
        expect.stringContaining('MailProvider.ts'),
        expect.stringContaining('config/mail.ts'),
      ]))

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain('passwordHash')

      const authProviderContent = await readFile(join(workspace.dir, 'app/Providers/AuthProvider.ts'), 'utf8')
      expect(authProviderContent).toContain(SHARE_INERTIA_AUTH_PROPS_SNIPPET)

      const blogAuthProvider = await readFile(
        resolve(import.meta.dir, '../../create-app/templates/blog/app/Providers/AuthProvider.ts'),
        'utf8',
      )
      expect(blogAuthProvider).toContain(SHARE_INERTIA_AUTH_PROPS_SNIPPET)

      const appContent = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(appContent).toContain('AuthProvider')
      expect(appContent).toContain('MailProvider')
      // CoreMailServiceProvider must be wired before our own MailProvider so
      // that container.singleton('mail', ...) resolves to our configured
      // manager instead of Core's empty-config default — matching the same
      // Core-then-app convention `guren add mail` uses, so the two stay
      // compatible if a user layers both onto the same app.
      expect(appContent).toContain("import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'")
      expect(appContent).toContain('providers: [DatabaseProvider, AuthProvider, CoreMailServiceProvider, MailProvider]')
      expect(appContent).toContain('auth: {}')

      const routesContent = await readFile(join(workspace.dir, 'routes/web.ts'), 'utf8')
      expect(routesContent).toContain("import { registerAuthRoutes } from './auth.js'")
      expect(routesContent).toContain('registerAuthRoutes(router)')

      const authRoutes = await readFile(join(workspace.dir, 'routes/auth.ts'), 'utf8')
      expect(authRoutes).toContain("import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'")
      expect(authRoutes).toContain("router.get('/register'")
      expect(authRoutes).toContain("router.post('/register'")
      expect(authRoutes).toContain("router.get('/forgot-password'")
      expect(authRoutes).toContain("router.post('/forgot-password'")
      expect(authRoutes).toContain("router.get('/reset-password'")
      expect(authRoutes).toContain("router.post('/reset-password'")

      // Emailed links must never be built from the request URL: it is
      // reconstructed from the `Host` header, so a forged host would mail the
      // victim a genuine reset token pointing at the attacker's server.
      const forgotPasswordController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/ForgotPasswordController.ts'),
        'utf8',
      )
      expect(forgotPasswordController).not.toContain('new URL(this.request.url).origin')
      expect(forgotPasswordController).toContain('const resetBaseUrl = `${appUrl(this.request)}/reset-password`')
      // Resolved before the account lookup: a misconfigured APP_URL throws, and
      // throwing only for addresses that exist would leak which ones do.
      expect(forgotPasswordController.indexOf('appUrl(this.request)')).toBeLessThan(
        forgotPasswordController.indexOf('await User.where({ email })'),
      )

      // ...and the helper they route through reads APP_URL and fails closed in
      // production rather than falling back to the request.
      const appUrlHelper = await readFile(join(workspace.dir, 'app/Auth/AppUrl.ts'), 'utf8')
      expect(appUrlHelper).toMatch(/process\.env\.APP_URL[\s\S]*NODE_ENV === 'production'[\s\S]*throw new Error\(/)

      const loginPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Login.tsx'), 'utf8')
      expect(loginPage).toContain('interface Props')
      expect(loginPage).toContain('href="/register"')
      expect(loginPage).toContain('href="/forgot-password"')
      expect(loginPage).not.toContain('Contact your administrator.')

      const loginController = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/LoginController.ts'), 'utf8')
      expect(loginController).toContain('validateBody(LoginSchema)')
      expect(loginController).toContain('pages.auth.Login')
      expect(loginController).not.toContain('safeParse')

      const registerController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/RegisterController.ts'),
        'utf8',
      )
      expect(registerController).toContain('validateBody(RegisterSchema)')
      expect(registerController).toContain('pages.auth.Register')
      expect(registerController).toContain('User.create(')

      const registerValidator = await readFile(
        join(workspace.dir, 'app/Http/Validators/RegisterValidator.ts'),
        'utf8',
      )
      expect(registerValidator).toContain('passwordConfirmation')
      expect(registerValidator).toContain('Passwords do not match.')
      expect(registerValidator).toContain('.toLowerCase()')

      const registerPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Register.tsx'), 'utf8')
      expect(registerPage).toContain('interface Props')
      expect(registerPage).toContain("form.post('/register')")

      const forgotController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/ForgotPasswordController.ts'),
        'utf8',
      )
      expect(forgotController).toContain('validateBody(ForgotPasswordSchema)')
      expect(forgotController).toContain('createPasswordResetToken(')
      // Not awaited: the transport round-trip only happens for known
      // accounts, so awaiting it would leak account existence via timing.
      expect(forgotController).toContain('void sendPasswordResetMail(')
      expect(forgotController).not.toContain('await sendPasswordResetMail(')

      const profileController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/ProfileController.ts'),
        'utf8',
      )
      expect(profileController).not.toContain('emailVerifiedAt')

      const resetController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/ResetPasswordController.ts'),
        'utf8',
      )
      expect(resetController).toContain('validateBody(ResetPasswordSchema)')
      expect(resetController).toContain('verifyPasswordResetToken(')
      expect(resetController).toContain('User.update(')

      const mailConfig = await readFile(join(workspace.dir, 'config/mail.ts'), 'utf8')
      expect(mailConfig).toContain("process.env.MAIL_DRIVER ?? 'log'")

      const mailProvider = await readFile(join(workspace.dir, 'app/Providers/MailProvider.ts'), 'utf8')
      expect(mailProvider).toContain("this.container.singleton('mail'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips registration scaffolding with --minimal', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-minimal-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      const created = await makeAuth({ force: true, minimal: true })

      expect(created).toHaveLength(13)
      expect(created).not.toEqual(expect.arrayContaining([
        expect.stringContaining('RegisterController.ts'),
        expect.stringContaining('RegisterValidator.ts'),
        expect.stringContaining('Register.tsx'),
        expect.stringContaining('ForgotPasswordController.ts'),
        expect.stringContaining('ResetPasswordController.ts'),
        expect.stringContaining('PasswordResetStore.ts'),
        expect.stringContaining('MailProvider.ts'),
        expect.stringContaining('config/mail.ts'),
      ]))

      const authRoutes = await readFile(join(workspace.dir, 'routes/auth.ts'), 'utf8')
      expect(authRoutes).not.toContain('RegisterController')
      expect(authRoutes).not.toContain('ForgotPasswordController')
      expect(authRoutes).not.toContain("router.get('/register'")
      expect(authRoutes).not.toContain("router.get('/forgot-password'")

      const loginPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Login.tsx'), 'utf8')
      expect(loginPage).not.toContain('href="/register"')
      expect(loginPage).not.toContain('href="/forgot-password"')
      expect(loginPage).toContain('Contact your administrator.')
    } finally {
      await workspace.cleanup()
    }
  })

  it('logs out through Inertia so the CSRF token reaches the request', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-logout-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ force: true })

      const layout = await readFile(join(workspace.dir, 'resources/js/components/Layout.tsx'), 'utf8')
      expect(layout).not.toContain('action="/logout"')
      expect(layout).toContain('href="/logout"')
      expect(layout).toContain('method="post"')
      expect(layout).toContain('as="button"')
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds email verification with --verify', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-verify-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`,
        'utf8',
      )

      const created = await makeAuth({ force: true, verify: true })

      expect(created).toEqual(expect.arrayContaining([
        expect.stringContaining('VerifyEmailController.ts'),
        expect.stringContaining('VerifyEmail.tsx'),
        expect.stringContaining('EmailVerificationStore.ts'),
        expect.stringContaining('EmailVerificationMail.ts'),
      ]))

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain('emailVerifiedAt: timestamp(')

      const authRoutes = await readFile(join(workspace.dir, 'routes/auth.ts'), 'utf8')
      expect(authRoutes).toContain("import VerifyEmailController from '../app/Http/Controllers/Auth/VerifyEmailController.js'")
      expect(authRoutes).toContain("router.get('/verify-email'")
      expect(authRoutes).toContain("router.get('/verify-email/confirm'")
      expect(authRoutes).toContain('requireVerifiedEmail')
      expect(authRoutes).toContain("router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' }), requireVerifiedEmail({ redirectTo: '/verify-email' }))")

      const registerController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/RegisterController.ts'),
        'utf8',
      )
      expect(registerController).toContain('createEmailVerificationToken(')
      expect(registerController).toContain('sendEmailVerificationMail(')
      expect(registerController).toContain("this.redirect('/verify-email')")

      const verifyController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/VerifyEmailController.ts'),
        'utf8',
      )
      expect(verifyController).toContain('completeEmailVerification(')
      expect(verifyController).toContain('emailVerifiedAt: new Date()')

      // Public — the emailed link must work from any device or expired session.
      expect(authRoutes).toContain("router.get('/verify-email/confirm', [VerifyEmailController, 'confirm']).name('verify-email.confirm')")
      expect(authRoutes).not.toContain("router.get('/verify-email/confirm', [VerifyEmailController, 'confirm'], requireAuthenticated")

      // Changing the profile email must reset verification and re-send the link.
      const profileController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/ProfileController.ts'),
        'utf8',
      )
      expect(profileController).toContain('emailVerifiedAt: null')
      expect(profileController).toContain('sendEmailVerificationMail(')
    } finally {
      await workspace.cleanup()
    }
  })

  it('inserts emailVerifiedAt next to an existing three-argument pgTable users block', async () => {
    // Regression test: a whole-block regex replace only matches Drizzle's
    // two-argument pgTable(name, columns) form. A users table already
    // carrying auth columns *and* a trailing index callback — the shape
    // make:auth's own generated schema.ts uses once wired up — must get a
    // single, in-place column insertion, not a duplicated `users` export.
    const workspace = await createTempWorkspace('guren-cli-make-auth-verify-existing-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text, uniqueIndex } from 'drizzle-orm/pg-core'

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    rememberToken: text('remember_token'),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)
`,
        'utf8',
      )

      await makeAuth({ force: true, verify: true })

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema.match(/export const users = pgTable\(/g)).toHaveLength(1)
      expect(schema).toContain("emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),")
      expect(schema).toContain('uniqueIndex')
      expect(schema).toContain("(table) => [uniqueIndex('users_email_unique').on(table.email)]")
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns and skips --verify when combined with --minimal', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-verify-minimal-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      const created = await makeAuth({ force: true, minimal: true, verify: true })

      expect(created).not.toEqual(expect.arrayContaining([
        expect.stringContaining('VerifyEmailController.ts'),
      ]))

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).not.toContain('emailVerifiedAt')
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds OAuth login with --oauth github,google', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`,
        'utf8',
      )

      const created = await makeAuth({ force: true, oauth: 'github,google' })

      expect(created).toEqual(expect.arrayContaining([
        expect.stringContaining('app/Providers/OAuthProvider.ts'),
        expect.stringContaining('OAuthController.ts'),
      ]))

      const provider = await readFile(join(workspace.dir, 'app/Providers/OAuthProvider.ts'), 'utf8')
      expect(provider).toContain('createGitHubOAuthProviderConfig')
      expect(provider).toContain('createGoogleOAuthProviderConfig')
      expect(provider).toContain("oauth.registerProvider('github'")
      expect(provider).toContain("oauth.registerProvider('google'")
      expect(provider).toContain('OAUTH_GITHUB_CLIENT_ID')
      expect(provider).toContain('OAUTH_GITHUB_REDIRECT_URI')
      expect(provider).toContain('OAUTH_GOOGLE_CLIENT_ID')
      // Providers register only when all three env vars are present — no
      // empty-credential fallback that would show a button leading nowhere.
      expect(provider).toContain('if (githubClientId && githubClientSecret && githubRedirectUri)')

      const controller = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'), 'utf8')
      expect(controller).toContain("z.enum(['github', 'google'])")
      expect(controller).toContain('githubId: profileId')
      expect(controller).toContain('googleId: profileId')
      expect(controller).toContain("this.make<OAuthManager>('oauth')")
      expect(controller).toContain('this.oauth().authorize(provider')
      expect(controller).toContain('this.oauth().handleCallback(provider')
      // OAuth accounts are passwordless — no synthetic password is generated
      // or hashed.
      expect(controller).not.toContain('password:')
      expect(controller).not.toContain('password: randomUUID')

      // `state` alone is transferable between browsers: an attacker can
      // authorize their own account, hold the `code`, and walk a visitor
      // through the callback to log them into the attacker's account. Handing
      // the session to the manager is what binds the state to this browser.
      expect(controller).toContain('session: this.auth.session()')
      // Both legs must present the same session — authorize() stores the
      // binding in it, handleCallback() reads it back.
      expect((controller.match(/session: this\.auth\.session\(\)/g) ?? []).length).toBe(2)
      expect(controller).toContain('already exists. Sign in with the method you originally used.')

      // Returning an email is not a claim that the provider checked it, so the
      // scaffold reads the typed signal @guren/server maps from the provider's
      // own key. Creating an account from an unverified address would let it
      // claim an email it does not own, which the collision check above then
      // makes permanent for the real owner.
      expect(controller).toContain('profile.emailVerified === false')
      expect(controller).toContain('has not verified this email address')
      // Providers that send no signal leave the field undefined — those users
      // (GitHub's /user, for one) must still be able to sign up.
      expect(controller).not.toContain('profile.emailVerified !== true')
      expect(controller).not.toContain('profile.raw.email_verified')
      // Only on the create path — an existing link must not break if the
      // provider's verification status changes later.
      const createBranch = controller.slice(controller.indexOf('if (!user) {'))
      expect(createBranch).toContain('profile.emailVerified === false')

      const authRoutes = await readFile(join(workspace.dir, 'routes/auth.ts'), 'utf8')
      expect(authRoutes).toContain("import OAuthController from '../app/Http/Controllers/Auth/OAuthController.js'")
      expect(authRoutes).toContain("router.get('/auth/:provider', [OAuthController, 'redirectToProvider'], requireGuest({ redirectTo: '/dashboard' }))")
      expect(authRoutes).toContain("router.get('/auth/:provider/callback', [OAuthController, 'callback'])")

      const loginPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Login.tsx'), 'utf8')
      expect(loginPage).toContain('Continue with GitHub')
      expect(loginPage).toContain('Continue with Google')
      expect(loginPage).toContain('href="/auth/github"')
      expect(loginPage).toContain('href="/auth/google"')

      const registerPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Register.tsx'), 'utf8')
      expect(registerPage).toContain('Continue with GitHub')

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain("githubId: text('github_id').unique()")
      expect(schema).toContain("googleId: text('google_id').unique()")
      // Passwordless OAuth accounts require a nullable hash column.
      expect(schema).toContain("passwordHash: text('password_hash'),")
    } finally {
      await workspace.cleanup()
    }
  })

  it('relaxes an existing notNull passwordHash when adding --oauth', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-relax-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
`,
        'utf8',
      )

      await makeAuth({ force: true, oauth: 'github' })

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain("passwordHash: text('password_hash'),")
      expect(schema).toContain("githubId: text('github_id').unique()")
      // Other columns keep their constraints.
      expect(schema).toContain("email: text('email').notNull().unique()")
    } finally {
      await workspace.cleanup()
    }
  })

  it('relaxes a mysql varchar passwordHash despite the comma in its options', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-mysql-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { mysqlTable, int, varchar, timestamp } from 'drizzle-orm/mysql-core'

export const users = mysqlTable('users', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  rememberToken: varchar('remember_token', { length: 255 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
`,
        'utf8',
      )

      await makeAuth({ force: true, oauth: 'github' })

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain("passwordHash: varchar('password_hash', { length: 255 }),")
      expect(schema).toContain("name: varchar('name', { length: 255 }).notNull()")
    } finally {
      await workspace.cleanup()
    }
  })

  // MySQL has no ON CONFLICT: onConflictDoNothing() is undefined on its query
  // builder and throws when the seeder runs.
  const seederUpserts = [
    {
      dialect: 'mysql',
      schema: MYSQL_SCHEMA_FIXTURE,
      expected: ".onDuplicateKeyUpdate({ set: { name: 'Demo User' } })",
      forbidden: 'onConflictDoNothing',
      context: 'MySqlSeederContext',
    },
    {
      dialect: 'pg',
      schema: PG_SCHEMA_FIXTURE,
      expected: '.onConflictDoNothing({ target: users.email })',
      forbidden: 'onDuplicateKeyUpdate',
      context: 'PostgresSeederContext',
    },
    {
      dialect: 'sqlite',
      schema: SQLITE_SCHEMA_FIXTURE,
      expected: '.onConflictDoNothing({ target: users.email })',
      forbidden: 'onDuplicateKeyUpdate',
      context: 'SqliteSeederContext',
    },
  ]

  for (const { dialect, schema, expected, forbidden, context } of seederUpserts) {
    it(`seeds the demo user with the ${dialect} upsert`, async () => {
      const workspace = await createTempWorkspace(`guren-cli-make-auth-seeder-${dialect}-`)
      try {
        await mkdir(join(workspace.dir, 'db'), { recursive: true })
        await writeFile(join(workspace.dir, 'db/schema.ts'), schema, 'utf8')

        await makeAuth({ force: true })

        const seeder = await readFile(join(workspace.dir, 'db/seeders/UsersSeeder.ts'), 'utf8')
        expect(seeder).toContain(expected)
        expect(seeder).not.toContain(forbidden)
        // Without the dialect's own context the seeder is typed against
        // PostgreSQL and rejects the schema it inserts into.
        expect(seeder).toContain(`import { defineSeeder, ScryptHasher, type ${context} } from '@guren/core'`)
        expect(seeder).toContain(`async ({ db }: ${context}) => {`)
      } finally {
        await workspace.cleanup()
      }
    })
  }

  it('leaves a passwordHash column on another table untouched', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-scope-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

export const serviceAccounts = pgTable('service_accounts', {
  id: serial('id').primaryKey(),
  passwordHash: text('password_hash').notNull(),
})

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
`,
        'utf8',
      )

      await makeAuth({ force: true, oauth: 'github' })

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      const [serviceAccountsBlock, usersBlock] = schema.split('export const users')
      expect(serviceAccountsBlock).toContain("passwordHash: text('password_hash').notNull()")
      expect(usersBlock).toContain("passwordHash: text('password_hash'),")
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps passwordHash notNull without --oauth', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-notnull-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`,
        'utf8',
      )

      await makeAuth({ force: true })

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain("passwordHash: text('password_hash').notNull()")
    } finally {
      await workspace.cleanup()
    }
  })

  it('requires a password on create only when password sign-up is the sole way in', async () => {
    const passwordOnly = await createTempWorkspace('guren-cli-make-auth-user-model-')
    try {
      await mkdir(join(passwordOnly.dir, 'db'), { recursive: true })
      await makeAuth({ force: true })

      const model = await readFile(join(passwordOnly.dir, 'app/Models/User.ts'), 'utf8')
      expect(model).toContain('base: AuthenticatableModel')
      expect(model).toContain("optionalOnCreate: ['passwordHash']")
      expect(model).toContain("requireOnCreate: ['password']")
      // Credential columns are denied structurally by AuthenticatableModel's
      // deniedFields() — the scaffold must not re-declare them via guarded.
      expect(model).not.toContain('static guarded')
    } finally {
      await passwordOnly.cleanup()
    }

    // OAuth accounts arrive without a password, so requiring one would make
    // the generated OAuth controller's User.create() fail to compile.
    const withOAuth = await createTempWorkspace('guren-cli-make-auth-user-model-oauth-')
    try {
      await mkdir(join(withOAuth.dir, 'db'), { recursive: true })
      await makeAuth({ force: true, oauth: 'github' })

      const model = await readFile(join(withOAuth.dir, 'app/Models/User.ts'), 'utf8')
      expect(model).toContain("optionalOnCreate: ['passwordHash']")
      expect(model).not.toContain('requireOnCreate')
    } finally {
      await withOAuth.cleanup()
    }
  })

  it('scaffolds OAuth buttons on the login page even with --minimal', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-minimal-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      const created = await makeAuth({ force: true, minimal: true, oauth: 'discord' })

      expect(created).toEqual(expect.arrayContaining([
        expect.stringContaining('app/Providers/OAuthProvider.ts'),
        expect.stringContaining('OAuthController.ts'),
      ]))
      expect(created).not.toEqual(expect.arrayContaining([
        expect.stringContaining('RegisterController.ts'),
        expect.stringContaining('Register.tsx'),
      ]))

      const provider = await readFile(join(workspace.dir, 'app/Providers/OAuthProvider.ts'), 'utf8')
      expect(provider).toContain('createDiscordOAuthProviderConfig')
      expect(provider).toContain('OAUTH_DISCORD_CLIENT_ID')

      const controller = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'), 'utf8')
      expect(controller).toContain("z.enum(['discord'])")
      expect(controller).toContain('discordId: profileId')

      const loginPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Login.tsx'), 'utf8')
      expect(loginPage).toContain('Continue with Discord')
      expect(loginPage).toContain('href="/auth/discord"')
    } finally {
      await workspace.cleanup()
    }
  })

  it('drops password login, registration, and reset with --oauth-only', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-only-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`,
        'utf8',
      )

      const created = await makeAuth({ force: true, oauth: 'github', oauthOnly: true })

      // Pinned so a newly added scaffold file can't slip into the
      // passwordless variant unnoticed — the per-file negative assertions
      // below only cover the files we already know about.
      expect(created).toHaveLength(13)
      expect(created).toEqual(expect.arrayContaining([
        expect.stringContaining('LoginController.ts'),
        expect.stringContaining('OAuthController.ts'),
        expect.stringContaining('app/Providers/OAuthProvider.ts'),
      ]))
      for (const absent of [
        'LoginValidator.ts',
        'RegisterController.ts',
        'RegisterValidator.ts',
        'Register.tsx',
        'ForgotPasswordController.ts',
        'ResetPasswordController.ts',
        'ForgotPassword.tsx',
        'ResetPassword.tsx',
        'PasswordResetStore.ts',
        'PasswordResetMail.ts',
        'MailProvider.ts',
        'config/mail.ts',
        // The demo user can only be signed in as with a password — seeding it
        // would be an unreachable row plus one scrypt hash.
        'UsersSeeder.ts',
      ]) {
        expect(created.join('\n')).not.toContain(absent)
      }

      const authRoutes = await readFile(join(workspace.dir, 'routes/auth.ts'), 'utf8')
      expect(authRoutes).toContain("router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')")
      expect(authRoutes).not.toContain("router.post('/login'")
      expect(authRoutes).not.toContain('RegisterController')
      expect(authRoutes).not.toContain('ForgotPasswordController')
      // Logout and the OAuth entry points stay.
      expect(authRoutes).toContain("router.post('/logout', [LoginController, 'destroy']")
      expect(authRoutes).toContain("router.get('/auth/:provider', [OAuthController, 'redirectToProvider']")
      expect(authRoutes).toContain("router.get('/auth/:provider/callback', [OAuthController, 'callback'])")

      const loginController = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/LoginController.ts'), 'utf8')
      expect(loginController).not.toContain('LoginSchema')
      expect(loginController).not.toContain('async store(')
      expect(loginController).not.toContain('this.auth.attempt(')
      expect(loginController).toContain('async show(')
      expect(loginController).toContain('async destroy(')

      const loginPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Login.tsx'), 'utf8')
      expect(loginPage).toContain('interface Props')
      expect(loginPage).toContain('Continue with GitHub')
      expect(loginPage).toContain('href="/auth/github"')
      // No password form left behind, and no "or" divider dangling above a
      // form that no longer exists.
      expect(loginPage).not.toContain('type="password"')
      expect(loginPage).not.toContain("form.post('/login')")
      expect(loginPage).not.toContain('Or continue with')
      expect(loginPage).not.toContain('href="/register"')
      expect(loginPage).not.toContain('href="/forgot-password"')
      // OAuthController still flashes ValidationException messages back here.
      expect(loginPage).toContain('errors.message')

      // A password set from the profile form could never be used to sign in,
      // and hashing it is the CPU cost --oauth-only exists to avoid.
      const profileValidator = await readFile(join(workspace.dir, 'app/Http/Validators/ProfileValidator.ts'), 'utf8')
      expect(profileValidator).not.toContain('password')
      const profileController = await readFile(join(workspace.dir, 'app/Http/Controllers/ProfileController.ts'), 'utf8')
      expect(profileController).not.toContain('password')
      const profilePage = await readFile(join(workspace.dir, 'resources/js/pages/profile/Edit.tsx'), 'utf8')
      expect(profilePage).not.toContain('password')

      // The email is provider-vouched and nothing re-verifies it in this mode,
      // so the profile must not be able to replace it — otherwise an account
      // could claim an address it never proved, and OAuthController's
      // collision check would then reject the real owner's first sign-in.
      expect(profileValidator).not.toContain('email')
      expect(profileController).toContain('const { name } = await this.validateBody(ProfileUpdateSchema)')
      expect(profileController).not.toContain('Email is already in use.')
      expect(profileController).toContain('User.update({ id: user.id }, { name })')
      expect(profilePage).not.toContain("form.setData('email'")
      expect(profilePage).toContain('Managed by your sign-in provider.')

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain("passwordHash: text('password_hash'),")
      expect(schema).toContain("githubId: text('github_id').unique()")
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects --oauth-only without a supported provider', async () => {
    // No schema fixture: the guard rejects before any file is read or written.
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-only-invalid-')
    try {
      // Neither reading is defensible: honouring it leaves no way to sign in,
      // ignoring it scaffolds the password login the flag opts out of.
      await expect(makeAuth({ force: true, oauthOnly: true })).rejects.toThrow('--oauth-only requires --oauth')
      // Same for a provider list that survives parsing with nothing in it.
      await expect(makeAuth({ force: true, oauthOnly: true, oauth: 'bogus' })).rejects.toThrow('--oauth-only requires --oauth')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about password files left behind when converting an app to --oauth-only', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-only-convert-')
    const warnings: string[] = []
    const originalWarn = consola.warn
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      // First a normal password scaffold, then convert it.
      await makeAuth({ force: true, verify: true })

      consola.warn = ((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '))
      }) as typeof consola.warn

      await makeAuth({ force: true, oauth: 'github', oauthOnly: true })

      // make:auth only writes the files it scaffolds — it never deletes — so
      // the password artifacts survive and must at least be reported.
      const report = warnings.join('\n')
      // Every file the password experience owns, including the mail wiring
      // that only exists to serve reset and verification.
      for (const stale of [
        'app/Http/Validators/LoginValidator.ts',
        'db/seeders/UsersSeeder.ts',
        'app/Http/Controllers/Auth/RegisterController.ts',
        'app/Http/Controllers/Auth/ForgotPasswordController.ts',
        'app/Http/Controllers/Auth/ResetPasswordController.ts',
        'app/Auth/PasswordResetStore.ts',
        'app/Mail/PasswordResetMail.ts',
        'app/Providers/MailProvider.ts',
        'config/mail.ts',
        // --verify's artifacts are password-experience-only too.
        'app/Http/Controllers/Auth/VerifyEmailController.ts',
        'app/Auth/EmailVerificationStore.ts',
        'app/Mail/EmailVerificationMail.ts',
      ]) {
        expect(report).toContain(stale)
      }
      // The seeder is found by db:seed rather than routed, so a dead route
      // table does not neutralize it.
      expect(report).toContain('still runs on `db:seed`')
      // Nothing rewrites the providers array, so the mail wiring survives too.
      expect(report).toContain('src/app.ts may still register MailProvider')
    } finally {
      consola.warn = originalWarn
      await workspace.cleanup()
    }
  })

  it('skips --verify under --oauth-only instead of scaffolding a verify flow', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-only-verify-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      const created = await makeAuth({ force: true, oauth: 'github', oauthOnly: true, verify: true })

      expect(created.join('\n')).not.toContain('VerifyEmailController.ts')
      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).not.toContain('emailVerifiedAt')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns and skips unknown OAuth provider names', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-unknown-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      const created = await makeAuth({ force: true, oauth: 'github,bogus' })

      const controller = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'), 'utf8')
      expect(controller).toContain("z.enum(['github'])")
      expect(controller).not.toContain('bogus')

      expect(created).toEqual(expect.arrayContaining([
        expect.stringContaining('OAuthController.ts'),
      ]))
    } finally {
      await workspace.cleanup()
    }
  })

  it('adds emailVerifiedAt and OAuth id columns together with --verify --oauth', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-verify-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`,
        'utf8',
      )

      await makeAuth({ force: true, verify: true, oauth: 'github,google' })

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain('emailVerifiedAt: timestamp(')
      expect(schema).toContain("githubId: text('github_id').unique()")
      expect(schema).toContain("googleId: text('google_id').unique()")
      expect(schema.match(/export const users = /g)).toHaveLength(1)

      // Without this, requireVerifiedEmail would strand every OAuth signup
      // at /verify-email forever — OAuthController never sends a
      // verification email, so there'd be nothing for them to click.
      const controller = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'), 'utf8')
      expect(controller).toContain('emailVerifiedAt: new Date()')
    } finally {
      await workspace.cleanup()
    }
  })

  it('omits emailVerifiedAt from OAuthController when --verify is not enabled', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-no-verify-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ force: true, oauth: 'github' })

      const controller = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'), 'utf8')
      expect(controller).not.toContain('emailVerifiedAt')
    } finally {
      await workspace.cleanup()
    }
  })

  it('idempotently adds only the missing provider column on re-run with --force', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-idempotent-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'db/schema.ts'),
        `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`,
        'utf8',
      )

      await makeAuth({ force: true, oauth: 'github' })
      const afterFirst = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(afterFirst).toContain("githubId: text('github_id').unique()")
      expect(afterFirst).not.toContain('googleId')

      await makeAuth({ force: true, oauth: 'github,google' })
      const afterSecond = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(afterSecond.match(/githubId: text\('github_id'\)\.unique\(\),/g)).toHaveLength(1)
      expect(afterSecond).toContain("googleId: text('google_id').unique()")
      expect(afterSecond.match(/export const users = /g)).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('wires CoreOAuthServiceProvider and OAuthProvider into app.ts with --install --oauth', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-install-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await mkdir(join(workspace.dir, 'db'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { createApp } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider],
})

export default app
`,
        'utf8',
      )

      await writeFile(
        join(workspace.dir, 'routes/web.ts'),
        `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', () => 'home')
}
`,
        'utf8',
      )

      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ install: true, force: true, minimal: true, oauth: 'github' })

      const appContent = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(appContent).toContain("import { OAuthServiceProvider as CoreOAuthServiceProvider } from '@guren/core'")
      expect(appContent).toContain("import OAuthProvider from '../app/Providers/OAuthProvider.js'")
      expect(appContent).toContain('providers: [DatabaseProvider, AuthProvider, CoreOAuthServiceProvider, OAuthProvider]')
    } finally {
      await workspace.cleanup()
    }
  })

  async function readProfileScaffold(dir: string) {
    return {
      controller: await readFile(join(dir, 'app/Http/Controllers/ProfileController.ts'), 'utf8'),
      validator: await readFile(join(dir, 'app/Http/Validators/ProfileValidator.ts'), 'utf8'),
      view: await readFile(join(dir, 'resources/js/pages/profile/Edit.tsx'), 'utf8'),
    }
  }

  it('scaffolds the profile email read-only with --oauth and no --verify', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-profile-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ force: true, oauth: 'github' })

      const { controller, validator, view } = await readProfileScaffold(workspace.dir)

      // The update action must never receive an email, even from a
      // hand-crafted request that bypasses the form.
      expect(validator).not.toContain('email: z')
      expect(validator).toContain('name: z')
      expect(validator).toContain('password: z')
      expect(controller).toContain('const { name, password } = await this.validateBody(ProfileUpdateSchema)')
      expect(controller).not.toContain('emailChanged')
      expect(controller).not.toContain('Email is already in use.')
      expect(controller).toContain('profile: { name, email: user.email }')

      expect(view).toContain('{profile.email}')
      expect(view).toContain('Managed by your sign-in provider.')
      expect(view).not.toContain("form.setData('email'")
      expect(view).not.toContain("ValidationErrors<'name' | 'email' | 'password'>")
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds the profile email read-only with --oauth --minimal', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-minimal-profile-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ force: true, minimal: true, oauth: 'github' })

      const { controller, validator, view } = await readProfileScaffold(workspace.dir)

      expect(validator).not.toContain('email: z')
      expect(validator).toContain('name: z')
      expect(validator).toContain('password: z')
      expect(controller).toContain('const { name, password } = await this.validateBody(ProfileUpdateSchema)')
      expect(view).toContain('Managed by your sign-in provider.')
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps the profile email editable with --oauth --verify', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-oauth-verify-profile-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ force: true, verify: true, oauth: 'github' })

      const { controller, validator, view } = await readProfileScaffold(workspace.dir)

      expect(validator).toContain("email('Enter a valid email address.')")
      expect(controller).toContain('const { name, email, password } = await this.validateBody(ProfileUpdateSchema)')
      // A replacement address loses the old one's verified status and has to
      // be re-proven before it counts.
      expect(controller).toContain('emailVerifiedAt: null')
      expect(view).toContain("form.setData('email'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps the profile email editable without --oauth', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-auth-profile-editable-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const posts = 'posts'\n`, 'utf8')

      await makeAuth({ force: true })

      const { controller, validator, view } = await readProfileScaffold(workspace.dir)

      expect(validator).toContain("email('Enter a valid email address.')")
      expect(controller).toContain('const { name, email, password } = await this.validateBody(ProfileUpdateSchema)')
      expect(controller).toContain('Email is already in use.')
      expect(view).toContain("form.setData('email'")
    } finally {
      await workspace.cleanup()
    }
  })
})
