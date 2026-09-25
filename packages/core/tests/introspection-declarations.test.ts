import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../..')
const TSC_BIN = join(repoRoot, 'node_modules/typescript/bin/tsc')

// Resolved through each package's `exports`, so this reads the built `.d.ts`
// an installed app sees, core's `export * from '@guren/server'` included.
const PROBE = `import { createApp, isIntrospecting, type AppManifest as CoreManifest, type ServiceProvider } from '@guren/core'
import type { AppManifest, RouteEntry } from '@guren/server'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const same: Equal<CoreManifest, AppManifest> = true
const manifest: Promise<CoreManifest> = createApp().introspect()
const flag: boolean = isIntrospecting()
const hook: ServiceProvider['introspect'] = undefined
const route = null as unknown as RouteEntry
const file: string | null | undefined = route.controller?.file
// @ts-expect-error schemaVersion is the literal 1
const version: CoreManifest['schemaVersion'] = 2

export { same, manifest, flag, hook, file, version }
`

let dir: string

beforeAll(async () => {
  for (const pkg of ['core', 'server']) {
    const declaration = join(repoRoot, 'packages', pkg, 'dist/index.d.ts')
    if (!existsSync(declaration)) throw new Error(`Expected ${declaration}; run \`bun run build ${pkg}\` before this test.`)
  }
  dir = await mkdtemp(join(tmpdir(), 'guren-manifest-types-'))
  await mkdir(join(dir, 'node_modules/@guren'), { recursive: true })
  for (const pkg of ['core', 'server']) {
    await symlink(join(repoRoot, 'packages', pkg), join(dir, 'node_modules/@guren', pkg), 'dir')
  }
  await writeFile(join(dir, 'probe.ts'), PROBE)
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, skipLibCheck: true, target: 'ES2022', module: 'ESNext',
      moduleResolution: 'Bundler', lib: ['es2022', 'dom'], types: [],
    },
    files: ['probe.ts'],
  }))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AppManifest in the built declarations', () => {
  test('reaches an app through @guren/server and through core\'s export *', () => {
    const result = Bun.spawnSync([process.execPath, TSC_BIN, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], { cwd: dir })
    const output = `${result.stdout}${result.stderr}`

    expect(output.split('\n').filter((line) => line.includes('error TS'))).toEqual([])
    expect(result.exitCode).toBe(0)
  }, 60_000)
})
