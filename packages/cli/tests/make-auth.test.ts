import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { makeAuth } from '../src/make-auth'

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

      expect(created).toHaveLength(26)
      expect(created).toEqual(expect.arrayContaining([
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

      const registerPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Register.tsx'), 'utf8')
      expect(registerPage).toContain('interface Props')
      expect(registerPage).toContain("form.post('/register')")

      const forgotController = await readFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/ForgotPasswordController.ts'),
        'utf8',
      )
      expect(forgotController).toContain('validateBody(ForgotPasswordSchema)')
      expect(forgotController).toContain('createPasswordResetToken(')
      expect(forgotController).toContain('sendPasswordResetMail(')

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
})
