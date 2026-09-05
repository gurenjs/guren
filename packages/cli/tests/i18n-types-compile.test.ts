import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertWorkspaceBuilt, checkTypes, TSC_TIMEOUT, type TsconfigCompilerOptions } from './helpers'
import { buildTranslationTypesContent } from '../src/i18n-types'

/**
 * Compile-time gate for the generated `.guren/translations.gen.ts`: only a
 * real program proves the `declare module` augmentations narrow `t()` through
 * the `@guren/server` → `@guren/core` re-export, where the merge could silently
 * stop applying. Augmentation is program-wide, so this runs its own tsc program
 * against the built `dist/index.d.ts` a real app imports (needs `bun run build`).
 */

const repoRoot = resolve(import.meta.dir, '../../..')
const coreTypes = join(repoRoot, 'packages/core/dist/index.d.ts')
const inertiaClientTypes = join(repoRoot, 'packages/inertia-client/dist/index.d.ts')

const SERVER_PROBE = `import { Controller } from '@guren/core'

export class ProbeController extends Controller {
  probe(): void {
    this.t('messages.welcome')
    this.tc('nav.posts', 2)
    // @ts-expect-error -- key absent from every lang/ catalog
    this.t('messages.missing')
    // @ts-expect-error -- key absent from every lang/ catalog
    this.tc('messages.missing', 1)
  }
}
`

const CLIENT_PROBE = `import { useTranslation } from '@guren/inertia-client'

declare const translation: ReturnType<typeof useTranslation>

export function probe(): void {
  translation.t('messages.welcome')
  translation.tc('nav.posts', 2)
  // @ts-expect-error -- key absent from every lang/ catalog
  translation.t('messages.missing')
  // @ts-expect-error -- key absent from every lang/ catalog
  translation.tc('messages.missing', 1)
}
`

const compilerOptions: TsconfigCompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'Bundler',
  types: [],
  paths: {
    '@guren/core': [coreTypes],
    '@guren/inertia-client': [inertiaClientTypes],
  },
}

let dir: string
let generatedFile: string
let serverProbeFile: string
let clientProbeFile: string

beforeAll(async () => {
  // An unbuilt checkout has to fail as itself, not as a probe that
  // mysteriously stopped narrowing.
  assertWorkspaceBuilt([coreTypes, inertiaClientTypes])

  dir = await mkdtemp(join(tmpdir(), 'guren-i18n-compile-'))
  generatedFile = join(dir, 'translations.gen.ts')
  serverProbeFile = join(dir, 'server-probe.ts')
  clientProbeFile = join(dir, 'client-probe.ts')

  await writeFile(
    generatedFile,
    buildTranslationTypesContent(['messages.welcome', 'nav.posts'], {
      locales: ['en'],
      augmentInertiaClient: true,
    }),
  )
  await writeFile(serverProbeFile, SERVER_PROBE)
  await writeFile(clientProbeFile, CLIENT_PROBE)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function check(rootNames: string[]): string[] {
  return checkTypes(rootNames, compilerOptions)
}

describe('generated translation key augmentation', () => {
  test('narrows t()/tc() on both surfaces: valid keys pass, unknown keys are rejected', () => {
    // Zero diagnostics proves both polarities: an accepted bad key would
    // surface as TS2578, "unused @ts-expect-error".
    expect(check([generatedFile, serverProbeFile, clientProbeFile])).toEqual([])
  }, TSC_TIMEOUT)

  test('without the generated file the same probes fail (the gate can catch a broken augmentation)', () => {
    const diagnostics = check([serverProbeFile, clientProbeFile])

    expect(diagnostics).toHaveLength(4)
    for (const diagnostic of diagnostics) {
      expect(diagnostic).toContain('TS2578')
    }
    expect(diagnostics.filter((d) => d.startsWith('server-probe.ts'))).toHaveLength(2)
    expect(diagnostics.filter((d) => d.startsWith('client-probe.ts'))).toHaveLength(2)
  }, TSC_TIMEOUT)
})
