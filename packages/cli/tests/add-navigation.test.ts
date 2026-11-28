import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import { addNavigation, judgeNavigationLayout, NAVIGATION_LAYOUT_FILE, navigationNextSteps, SHIPPED_LAYOUTS } from '../src/add-navigation'
import { uiComponentHash } from '../src/guren-css'
import { insertCallOptions } from '../src/patch-helpers'
import { createTempWorkspace, linkWorkspaceCore, seedApiOnlyApp, writeWorkspaceFiles } from './helpers'

const TEMPLATES = resolve(import.meta.dir, '../templates/scaffold/auth')
const template = (path: string): Promise<string> => readFile(join(TEMPLATES, path), 'utf8')
// The layout v2.12.0 to v2.38.1 wrote, as `git show v2.38.1:` gives it.
const SHIPPED_V2_12 = resolve(import.meta.dir, 'fixtures/navigation/Layout.v2.12.tsx.txt')

const APP_ENTRY = "import { createApp } from '@guren/core'\nimport { registerWebRoutes } from '../routes/web.js'\n\nconst app = createApp({ routes: registerWebRoutes })\n\nexport default app\n"
const routes = (body: string): string => `import { Router } from '@guren/core'\n\nexport function registerWebRoutes(router: Router): void {\n${body}}\n`
// The routes the auth layout links outside its entries.
const ACCOUNT = "  router.get('/login', () => 'login')\n  router.get('/profile', () => 'profile')\n  router.post('/logout', () => 'logout')\n"

describe('SHIPPED_LAYOUTS', () => {
  it('lists the current template, so an app that ran this release\'s add auth reads as current', async () => {
    expect(SHIPPED_LAYOUTS.has(uiComponentHash(await template(NAVIGATION_LAYOUT_FILE)))).toBe(true)
  })

  it('lists the layout v2.12.0 to v2.38.1 wrote', async () => {
    expect(SHIPPED_LAYOUTS.has(uiComponentHash(await readFile(SHIPPED_V2_12, 'utf8')))).toBe(true)
  })
})

describe('judgeNavigationLayout', () => {
  it('replaces a shipped version, CRLF line ends included, and keeps anything else', async () => {
    const current = await template(NAVIGATION_LAYOUT_FILE)
    const old = await readFile(SHIPPED_V2_12, 'utf8')
    expect(judgeNavigationLayout(null, current)).toBe('absent')
    expect(judgeNavigationLayout(current, current)).toBe('current')
    expect(judgeNavigationLayout(old, current)).toBe('replaced')
    expect(judgeNavigationLayout(old.replaceAll('\n', '\r\n'), current)).toBe('replaced')
    expect(judgeNavigationLayout(old.replace('Dashboard', 'Home'), current)).toBe('kept')
  })
})

describe('addNavigation', () => {
  it('writes and wires config/navigation.ts and replaces a layout an earlier add auth wrote', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'src/app.ts': APP_ENTRY,
        'routes/web.ts': routes(`  router.get('/', () => 'home').name('home')\n  router.get('/dashboard', () => 'dashboard').name('dashboard')\n${ACCOUNT}`),
        [NAVIGATION_LAYOUT_FILE]: await readFile(SHIPPED_V2_12, 'utf8'),
      })
      await linkWorkspaceCore(workspace.dir)

      const overwritten: string[] = []
      const result = await addNavigation({ overwritten })

      expect(result).toMatchObject({ navigation: 'written', layout: 'replaced', omitted: [] })
      expect(await readFile(join(workspace.dir, 'config/navigation.ts'), 'utf8')).toBe(await template('config/navigation.ts'))
      expect(await readFile(join(workspace.dir, NAVIGATION_LAYOUT_FILE), 'utf8')).toBe(await template(NAVIGATION_LAYOUT_FILE))
      expect(await readFile(join(workspace.dir, 'lang/en/layout.json'), 'utf8')).toBe(await template('lang/en/layout.json'))
      const root = await realpath(workspace.dir)
      expect(overwritten.map((file) => relative(root, file))).toEqual([NAVIGATION_LAYOUT_FILE])
      expect(result.created.map((file) => relative(root, file))).toEqual(['config/navigation.ts', 'lang/en/layout.json', NAVIGATION_LAYOUT_FILE])
      const entry = await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')
      expect(entry).toMatch(/import navigation from '\.\.\/config\/navigation(\.js)?'/)
      expect(entry).toMatch(/config: \[navigation\]/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves an edited layout and an existing definition alone, and prints what the layout needs', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-kept-')
    try {
      const layout = (await readFile(SHIPPED_V2_12, 'utf8')).replace('Dashboard', 'Home')
      const navigation = "import { defineNavigation } from '@guren/core'\n\nexport default defineNavigation([])\n"
      await writeWorkspaceFiles(workspace.dir, {
        'src/app.ts': APP_ENTRY,
        'routes/web.ts': routes("  router.get('/', () => 'home')\n"),
        'config/navigation.ts': navigation,
        [NAVIGATION_LAYOUT_FILE]: layout,
      })
      await linkWorkspaceCore(workspace.dir)

      const result = await addNavigation()

      expect(result).toEqual({ created: [], navigation: 'kept', layout: 'kept', omitted: [] })
      expect(await readFile(join(workspace.dir, NAVIGATION_LAYOUT_FILE), 'utf8')).toBe(layout)
      expect(await readFile(join(workspace.dir, 'config/navigation.ts'), 'utf8')).toBe(navigation)
      expect(existsSync(join(workspace.dir, 'lang/en/layout.json'))).toBe(false)
      expect(await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')).toMatch(/config: \[navigation\]/)
      expect(navigationNextSteps(result)).toEqual([
        `${NAVIGATION_LAYOUT_FILE} is not a layout the framework shipped, so it was left as it is. Render the navigation prop in it:`,
        "  import { Link, usePage } from '@inertiajs/react'",
        "  import type { NavigationItem } from '@guren/core'",
        '  // in the component:',
        '  const navigation = usePage<{ navigation?: NavigationItem[] }>().props.navigation ?? []',
        '  // in the header:',
        "  {navigation.map((item) => <Link key={item.path} href={item.path} aria-current={item.current ? 'page' : undefined}>{item.label}</Link>)}",
      ])
    } finally {
      await workspace.cleanup()
    }
  })

  it('writes no layout where there is none, and leaves out the entries whose routes the app does not name', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-bare-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'src/app.ts': APP_ENTRY,
        'routes/web.ts': routes("  router.get('/', () => 'home')\n"),
        'resources/js/pages/Home.tsx': 'export default function Home() { return null }\n',
      })
      await linkWorkspaceCore(workspace.dir)

      const result = await addNavigation()

      expect(result).toMatchObject({ navigation: 'written', layout: 'absent', omitted: ['home', 'dashboard'] })
      expect(existsSync(join(workspace.dir, NAVIGATION_LAYOUT_FILE))).toBe(false)
      const navigation = await readFile(join(workspace.dir, 'config/navigation.ts'), 'utf8')
      expect(navigation).toContain('export default defineNavigation([\n])\n')
      expect(navigationNextSteps(result)).toContain(
        `No GET route with no path parameter is named home, so config/navigation.ts has no Home entry: name your / route with .name('home'), then run bunx guren nav:add "Home" --route home.`,
      )
    } finally {
      await workspace.cleanup()
    }
  })

  it('holds a shipped layout whose account links the app does not register', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-held-')
    try {
      const layout = await readFile(SHIPPED_V2_12, 'utf8')
      await writeWorkspaceFiles(workspace.dir, {
        'src/app.ts': APP_ENTRY,
        'routes/web.ts': routes("  router.get('/login', () => 'login')\n  router.post('/logout', () => 'logout')\n"),
        [NAVIGATION_LAYOUT_FILE]: layout,
      })
      await linkWorkspaceCore(workspace.dir)

      const result = await addNavigation()

      expect(result).toMatchObject({ layout: 'held', layoutHeld: 'the new layout links GET /profile, which the routes file does not register' })
      expect(await readFile(join(workspace.dir, NAVIGATION_LAYOUT_FILE), 'utf8')).toBe(layout)
      expect(existsSync(join(workspace.dir, 'lang/en/layout.json'))).toBe(false)
      expect(navigationNextSteps(result)[0]).toBe(`${NAVIGATION_LAYOUT_FILE} was left as it is, since the new layout links GET /profile, which the routes file does not register. Render the navigation prop in it:`)
    } finally {
      await workspace.cleanup()
    }
  })

  it('refuses before writing when the installed server has no defineNavigation()', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-old-server-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'src/app.ts': APP_ENTRY,
        'routes/web.ts': routes(''),
        // The server @guren/core re-exports, resolved from core's own directory up.
        'node_modules/@guren/core/package.json': '{ "name": "@guren/core", "types": "index.d.ts" }\n',
        'node_modules/@guren/core/index.d.ts': "export * from '@guren/server'\n",
        'node_modules/@guren/server/package.json': '{ "name": "@guren/server", "exports": { ".": { "import": { "types": "./dist/index.d.ts" } } } }\n',
        'node_modules/@guren/server/dist/index.d.ts': 'export declare function createApp(): void\n',
      })

      await expect(addNavigation()).rejects.toThrow('The installed @guren/core exports no defineNavigation()')
      expect(existsSync(join(workspace.dir, 'config/navigation.ts'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('neither replaces nor wires a config/navigation.ts that is no definition', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-foreign-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'src/app.ts': APP_ENTRY,
        'routes/web.ts': routes(ACCOUNT),
        'config/navigation.ts': 'export const links = []\n',
        [NAVIGATION_LAYOUT_FILE]: await readFile(SHIPPED_V2_12, 'utf8'),
      })
      await linkWorkspaceCore(workspace.dir)

      const result = await addNavigation()

      expect(result.navigation).toBe('foreign')
      // Nothing would share the links the new layout renders, so the shipped one stays.
      expect(result).toMatchObject({ layout: 'held', layoutHeld: 'config/navigation.ts is no defineNavigation() definition, so nothing would share the links the new layout renders' })
      expect(await readFile(join(workspace.dir, NAVIGATION_LAYOUT_FILE), 'utf8')).toBe(await readFile(SHIPPED_V2_12, 'utf8'))
      expect(await readFile(join(workspace.dir, 'config/navigation.ts'), 'utf8')).toBe('export const links = []\n')
      expect(await readFile(join(workspace.dir, 'src/app.ts'), 'utf8')).not.toContain('navigation')
    } finally {
      await workspace.cleanup()
    }
  })

  it('holds a shipped layout that is a symbolic link, and one createApp() could not be made to list', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-link-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'src/app.ts': APP_ENTRY,
        'routes/web.ts': routes(ACCOUNT),
        'shared/Layout.tsx': await readFile(SHIPPED_V2_12, 'utf8'),
      })
      await mkdir(join(workspace.dir, 'resources/js/components'), { recursive: true })
      await symlink(join(workspace.dir, 'shared/Layout.tsx'), join(workspace.dir, NAVIGATION_LAYOUT_FILE))
      await linkWorkspaceCore(workspace.dir)

      expect(await addNavigation()).toMatchObject({ layout: 'held', layoutHeld: 'it is a symbolic link, and a write would change the file it points to' })
      expect(await readFile(join(workspace.dir, 'shared/Layout.tsx'), 'utf8')).toBe(await readFile(SHIPPED_V2_12, 'utf8'))
    } finally {
      await workspace.cleanup()
    }

    const unwired = await createTempWorkspace('guren-cli-add-navigation-unwired-')
    try {
      await writeWorkspaceFiles(unwired.dir, {
        // A config the patcher cannot extend leaves the wiring to the author.
        'src/app.ts': "import { createApp } from '@guren/core'\nimport { registerWebRoutes } from '../routes/web.js'\n\nconst config = []\nconst app = createApp({ routes: registerWebRoutes, config })\n\nexport default app\n",
        'routes/web.ts': routes(ACCOUNT),
        [NAVIGATION_LAYOUT_FILE]: await readFile(SHIPPED_V2_12, 'utf8'),
      })
      await linkWorkspaceCore(unwired.dir)

      expect(await addNavigation()).toMatchObject({ layout: 'held', layoutHeld: 'createApp() does not list config/navigation.ts yet, so nothing would share the links the new layout renders' })
      expect(await readFile(join(unwired.dir, NAVIGATION_LAYOUT_FILE), 'utf8')).toBe(await readFile(SHIPPED_V2_12, 'utf8'))
      expect(existsSync(join(unwired.dir, 'lang/en/layout.json'))).toBe(false)
    } finally {
      await unwired.cleanup()
    }
  })

  it('refuses an API-only app', async () => {
    const workspace = await createTempWorkspace('guren-cli-add-navigation-api-')
    try {
      await seedApiOnlyApp(workspace.dir)
      await expect(addNavigation()).rejects.toThrow('guren add navigation writes the links of an Inertia layout')
      expect(existsSync(join(workspace.dir, 'config/navigation.ts'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('insertCallOptions', () => {
  it('reads a shorthand option as set, and a key nested in another option as not', () => {
    expect(insertCallOptions('createApp({ routes, config })', [{ key: 'config', source: '[navigation]' }], 'createApp')).toEqual({ content: 'createApp({ routes, config })', inserted: [] })
    const nested = insertCallOptions('createApp({ providers: [config], session: { config: 1 } })', [{ key: 'config', source: '[navigation]' }], 'createApp')
    expect(nested).toEqual({ content: 'createApp({\n  config: [navigation], providers: [config], session: { config: 1 } })', inserted: ['config'] })
  })
})
