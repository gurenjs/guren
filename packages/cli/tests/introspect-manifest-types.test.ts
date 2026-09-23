import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  assertWorkspaceBuilt,
  checkTypes,
  createTempRoot,
  GENERATED_MODULE_COMPILER_OPTIONS,
  linkWorkspacePackage,
  TSC_TIMEOUT,
} from './helpers'

const repoRoot = resolve(import.meta.dir, '../../..')

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
  assertWorkspaceBuilt([join(repoRoot, 'packages/core/dist/index.d.ts'), join(repoRoot, 'packages/server/dist/index.d.ts')])
  dir = await createTempRoot('guren-manifest-types-')
  await linkWorkspacePackage('core', dir)
  await linkWorkspacePackage('server', dir)
  await writeFile(join(dir, 'probe.ts'), PROBE)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('AppManifest in the built declarations', () => {
  test('reaches an app through @guren/server and through core\'s export *', () => {
    expect(checkTypes([join(dir, 'probe.ts')], GENERATED_MODULE_COMPILER_OPTIONS)).toEqual([])
  }, TSC_TIMEOUT)
})
