import { describe, expect, it } from 'bun:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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

      expect(created).toHaveLength(14)
      expect(created).toEqual(expect.arrayContaining([
        expect.stringContaining('LoginController.ts'),
        expect.stringContaining('routes/auth.ts'),
        expect.stringContaining('ProfileController.ts'),
        expect.stringContaining('ProfileValidator.ts'),
      ]))

      const migrations = await readdir(join(workspace.dir, 'db/migrations'))
      expect(migrations.some((name) => name.endsWith('_create_users_table.sql'))).toBe(true)

      const schema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      expect(schema).toContain('passwordHash')

      const appContent = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(appContent).toContain('AuthProvider')
      expect(appContent).toContain('providers: [DatabaseProvider, AuthProvider]')

      const routesContent = await readFile(join(workspace.dir, 'routes/web.ts'), 'utf8')
      expect(routesContent).toContain("import registerAuthRoutes from './auth.js'")
      expect(routesContent).toContain('registerAuthRoutes(router)')

      const loginPage = await readFile(join(workspace.dir, 'resources/js/pages/auth/Login.tsx'), 'utf8')
      expect(loginPage).toContain('interface Props')

      const loginController = await readFile(join(workspace.dir, 'app/Http/Controllers/Auth/LoginController.ts'), 'utf8')
      expect(loginController).toContain('validateBody(LoginSchema)')
      expect(loginController).toContain('pages.auth.Login')
      expect(loginController).not.toContain('safeParse')
    } finally {
      await workspace.cleanup()
    }
  })
})
