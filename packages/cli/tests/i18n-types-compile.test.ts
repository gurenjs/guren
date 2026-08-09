import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import ts from 'typescript'
import { buildTranslationTypesContent } from '../src/i18n-types'

/**
 * Compile-time gate for the generated `.guren/translations.gen.ts`: the text
 * assertions in i18n-codegen.test.ts cannot prove the emitted `declare module`
 * augmentations actually narrow `Controller.t()` / `useTranslation()` — the
 * interfaces they merge into are declared in `@guren/server` and only
 * re-exported by `@guren/core`, and that indirection is exactly where the
 * merge could silently stop applying.
 *
 * Module augmentation is program-wide, so the probe runs in its own tsc
 * program here rather than inside any package's typecheck. It resolves
 * `@guren/core` / `@guren/inertia-client` to their built `dist/index.d.ts` —
 * the same surface a real app imports — which is why this test, like the rest
 * of this package's suite, requires `bun run build` to have run first.
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

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
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
  for (const file of [coreTypes, inertiaClientTypes]) {
    if (!existsSync(file)) {
      throw new Error(`${file} is missing — run \`bun run build\` first. This test type-checks probe code against the built .d.ts, the surface real apps import.`)
    }
  }

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
  const program = ts.createProgram(rootNames, compilerOptions)
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    if (!diagnostic.file || diagnostic.start === undefined) {
      return `TS${diagnostic.code}: ${message}`
    }
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    return `${basename(diagnostic.file.fileName)}:${line + 1} TS${diagnostic.code}: ${message}`
  })
}

describe('generated translation key augmentation', () => {
  test('narrows t()/tc() on both surfaces: valid keys pass, unknown keys are rejected', () => {
    // Zero diagnostics means every valid-key call type-checked AND every
    // bad-key probe errored (an accepted bad key surfaces as TS2578,
    // "unused @ts-expect-error").
    expect(check([generatedFile, serverProbeFile, clientProbeFile])).toEqual([])
  })

  test('without the generated file the same probes fail (the gate can catch a broken augmentation)', () => {
    const diagnostics = check([serverProbeFile, clientProbeFile])

    expect(diagnostics).toHaveLength(4)
    for (const diagnostic of diagnostics) {
      expect(diagnostic).toContain('TS2578')
    }
    expect(diagnostics.filter((d) => d.startsWith('server-probe.ts'))).toHaveLength(2)
    expect(diagnostics.filter((d) => d.startsWith('client-probe.ts'))).toHaveLength(2)
  })
})
