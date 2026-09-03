// The smokes consuming this list take ten minutes each, so a derivation that
// quietly stopped covering a package would surface a release late — how
// `@guren/testing` went missing from two of the three lists. These run fast.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertLocalGurenDependencies, collectLocalPackages } from './local-packages'

async function withApp(
  manifest: unknown,
  body: (appDir: string) => Promise<void>,
): Promise<void> {
  const appDir = await mkdtemp(join(tmpdir(), 'guren-local-packages-'))
  try {
    await writeFile(join(appDir, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8')
    await body(appDir)
  } finally {
    await rm(appDir, { recursive: true, force: true })
  }
}

describe('collectLocalPackages', () => {
  test('covers what the templates declare, including the devDependency', async () => {
    const names = (await collectLocalPackages()).map((pkg) => pkg.name)

    // The one the hand-maintained lists disagreed about: a devDependency of
    // both templates, which is exactly why two of them dropped it.
    expect(names).toContain('@guren/testing')
    expect(names).toContain('@guren/cli')
    expect(names).toContain('@guren/core')
    expect(names).toContain('@guren/orm')
  })

  test('closes over the workspace graph, not just the declared names', async () => {
    const names = (await collectLocalPackages()).map((pkg) => pkg.name)

    // No template names @guren/server; it arrives through @guren/core.
    expect(names).toContain('@guren/server')
  })

  test('leaves out packages no scaffolded app resolves', async () => {
    const names = (await collectLocalPackages()).map((pkg) => pkg.name)

    // Vendoring these would demand build output the smokes never load.
    expect(names).not.toContain('create-guren-app')
    expect(names.filter((name) => name.startsWith('@guren/plugin-'))).toEqual([])
  })
})

describe('assertLocalGurenDependencies', () => {
  test('accepts a manifest whose @guren/* entries all resolve locally', async () => {
    await withApp(
      {
        dependencies: { '@guren/core': 'file:.guren-vendor/core', react: '^19.0.0' },
        devDependencies: { '@guren/testing': 'file:.guren-vendor/testing' },
      },
      async (appDir) => {
        await assertLocalGurenDependencies(appDir, 'The app')
      },
    )
  })

  test('rejects a registry range left behind in any group, naming it', async () => {
    await withApp(
      {
        dependencies: { '@guren/core': 'file:.guren-vendor/core' },
        devDependencies: { '@guren/testing': '^1.3.0' },
      },
      async (appDir) => {
        await expect(assertLocalGurenDependencies(appDir, 'The app')).rejects.toThrow(
          /devDependencies\.@guren\/testing \(\^1\.3\.0\)/,
        )
      },
    )
  })

  test('accepts tarball and workspace specifiers', async () => {
    await withApp(
      {
        dependencies: { '@guren/cli': 'file:.guren-packed/guren-cli-2.2.0.tgz' },
        devDependencies: { '@guren/testing': 'workspace:*' },
      },
      async (appDir) => {
        await assertLocalGurenDependencies(appDir, 'The app')
      },
    )
  })
})
