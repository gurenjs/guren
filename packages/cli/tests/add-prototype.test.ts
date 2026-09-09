import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { addPrototype, PROTOTYPE_SCRIPTS } from '../src/add-prototype'
import { runBlueprint } from '../src/blueprints'
import { createTempWorkspace, seedInertiaApp, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const CLIENT_ENTRY = `import '../css/app.css'
import { pageManifest } from '@/.guren/pages.gen'

void import('@guren/inertia-client').then(({ startInertiaClient }) =>
  startInertiaClient({
    pages: import.meta.glob('./pages/**/*.tsx'),
    pageManifest,
  }),
)
`

const PACKAGE_JSON = `${JSON.stringify({ name: 'app', scripts: { dev: 'bun run dev:server', build: 'bunx vite build' } }, null, 2)}\n`

async function seed(dir: string, extra: Record<string, string> = {}): Promise<void> {
  await seedInertiaApp(dir)
  await writeWorkspaceFiles(dir, {
    'resources/js/app.tsx': CLIENT_ENTRY,
    'package.json': PACKAGE_JSON,
    ...extra,
  })
}

const read = (path: string) => readFile(resolve(path), 'utf8')

describe('guren add prototype', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-add-prototype-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('writes the fixture and wires the client entry, the app entry, the env declaration and the scripts', async () => {
    await seed(workspace.dir)

    const created = await runBlueprint('prototype', {})

    expect(created).toHaveLength(1)
    expect(created[0]).toEndWith('resources/js/prototype/index.ts')
    expect(await read('resources/js/prototype/index.ts')).toContain('export default definePrototype({')

    const client = await read('resources/js/app.tsx')
    expect(client).toContain("startInertiaClient({\n    // `vite --mode prototype`")
    expect(client).toContain("prototype: import.meta.env.GUREN_PROTOTYPE")
    expect(client).toContain("load: () => import('./prototype/index.js'), base: import.meta.env.BASE_URL")

    const app = await read('src/app.ts')
    expect(app).toContain("prototype: () => import('../resources/js/prototype/index.js'),")

    expect(await read('resources/js/vite-env.d.ts')).toContain('readonly GUREN_PROTOTYPE: boolean')

    const manifest = JSON.parse(await read('package.json')) as { scripts: Record<string, string> }
    expect(manifest.scripts['dev:prototype']).toBe(PROTOTYPE_SCRIPTS['dev:prototype'])
    expect(manifest.scripts['build:prototype']).toBe(PROTOTYPE_SCRIPTS['build:prototype'])
    expect(manifest.scripts.dev).toBe('bun run dev:server')
  })

  it('is idempotent: a second run changes nothing', async () => {
    await seed(workspace.dir)
    await runBlueprint('prototype', {})
    const snapshot = await Promise.all(
      ['resources/js/app.tsx', 'src/app.ts', 'resources/js/vite-env.d.ts', 'package.json', 'resources/js/prototype/index.ts'].map(read),
    )

    const created = await runBlueprint('prototype', {})

    expect(created).toEqual([])
    const again = await Promise.all(
      ['resources/js/app.tsx', 'src/app.ts', 'resources/js/vite-env.d.ts', 'package.json', 'resources/js/prototype/index.ts'].map(read),
    )
    expect(again).toEqual(snapshot)
  })

  it('appends the env declaration to an existing vite-env.d.ts', async () => {
    await seed(workspace.dir, { 'resources/js/vite-env.d.ts': "declare module '@vite/client'\n" })

    await runBlueprint('prototype', {})

    const declaration = await read('resources/js/vite-env.d.ts')
    expect(declaration).toContain("declare module '@vite/client'")
    expect(declaration).toContain('readonly GUREN_PROTOTYPE: boolean')
  })

  it('--remove reverses the wiring and the scripts and keeps the fixture', async () => {
    await seed(workspace.dir)
    await runBlueprint('prototype', {})

    await addPrototype({ remove: true })

    expect(await read('resources/js/app.tsx')).toBe(CLIENT_ENTRY)
    expect(await read('src/app.ts')).not.toContain('prototype:')
    const manifest = JSON.parse(await read('package.json')) as { scripts: Record<string, string> }
    expect(manifest.scripts['dev:prototype']).toBeUndefined()
    expect(manifest.scripts['build:prototype']).toBeUndefined()
    expect(manifest.scripts.build).toBe('bunx vite build')
    expect(await read('resources/js/prototype/index.ts')).toContain('definePrototype')
    expect(await read('resources/js/vite-env.d.ts')).toContain('GUREN_PROTOTYPE')
  })

  it('--remove leaves an edited script alone', async () => {
    await seed(workspace.dir)
    await runBlueprint('prototype', {})
    const manifest = JSON.parse(await read('package.json')) as { scripts: Record<string, string> }
    manifest.scripts['build:prototype'] = 'echo custom'
    await writeWorkspaceFiles(workspace.dir, { 'package.json': `${JSON.stringify(manifest, null, 2)}\n` })

    await addPrototype({ remove: true })

    const after = JSON.parse(await read('package.json')) as { scripts: Record<string, string> }
    expect(after.scripts['build:prototype']).toBe('echo custom')
    expect(after.scripts['dev:prototype']).toBeUndefined()
  })

  it('refuses an API-only app', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'routes/api.ts': "export function registerApiRoutes() {}\n",
      'src/app.ts': "import { createApp } from '@guren/core'\nexport default createApp({})\n",
      'package.json': PACKAGE_JSON,
    })

    await expect(runBlueprint('prototype', {})).rejects.toThrow(/API-only|api-only|cannot render/u)
  })
})
