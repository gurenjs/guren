import { beforeEach, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { upgradeCanary, checkVersionCompatibility } from '../src/upgrade'
import { findApplicableCodemods, compareVersions, codemods, type Codemod } from '../src/codemods'
import { checkDeprecations } from '../src/deprecations'

describe('upgradeCanary', () => {
  let workspace: TempWorkspace
  let packageJsonPath: string

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-upgrade-')
    packageJsonPath = join(workspace.dir, 'package.json')
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'upgrade-test',
        dependencies: {
          '@guren/core': '^0.2.0-alpha.7',
          '@guren/server': 'workspace:*',
          react: '^19.0.0',
        },
        devDependencies: {
          '@guren/testing': '^0.2.0-alpha.7',
        },
      }, null, 2),
      'utf8',
    )
    await writeFile(
      join(workspace.dir, 'tsconfig.json'),
      JSON.stringify({
        include: ['src/**/*'],
      }, null, 2),
      'utf8',
    )
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('updates Guren packages to canary', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, tag: 'canary' })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    expect(result.updatedDependencies).toHaveLength(3)
    expect(result.autofixes.some((autofix) => autofix.key === 'scripts' && autofix.applied)).toBe(true)
    expect(result.autofixes.some((autofix) => autofix.key === 'tsconfig' && autofix.applied)).toBe(true)
    expect(packageJson.dependencies['@guren/core']).toBe('canary')
    expect(packageJson.dependencies['@guren/server']).toBe('canary')
    expect(packageJson.devDependencies['@guren/testing']).toBe('canary')
    expect(packageJson.dependencies.react).toBe('^19.0.0')
  })


  it('resolves the default tag and reports the version it landed on', async () => {
    const tags: string[] = []
    const result = await upgradeCanary({
      cwd: workspace.dir,
      versionResolver: async (name, tag) => {
        tags.push(tag)
        return name.startsWith('@guren/') ? '1.0.0-rc.99' : null
      },
    })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    expect(tags.every((tag) => tag === 'latest')).toBe(true)
    // The report names the resolved version, not the tag, so a tag pointing at
    // an older line cannot read as a clean upgrade.
    expect(result.versionCompatibility?.targetVersion).toBe('1.0.0-rc.99')
    expect(result.versionCompatibility?.downgrade).toBe(false)
    expect(packageJson.dependencies['@guren/core']).toBe('^1.0.0-rc.99')
    expect(packageJson.dependencies['@guren/server']).toBe('^1.0.0-rc.99')
    expect(packageJson.devDependencies['@guren/testing']).toBe('^1.0.0-rc.99')
    expect(packageJson.dependencies.react).toBe('^19.0.0')
  })

  it('degrades to a warning when the registry lookup throws', async () => {
    const result = await upgradeCanary({
      cwd: workspace.dir,
      versionResolver: async () => {
        throw new Error('ENOTFOUND registry.npmjs.org')
      },
    })

    // A cached rejection used to be replayed uncaught by the second caller,
    // taking the whole command down when the registry was unreachable.
    expect(result.updatedDependencies).toHaveLength(0)
    expect(result.versionCompatibility?.resolvedTarget).toBe(false)
    expect(result.versionCompatibility?.warnings.join('\n')).toContain('Could not resolve')
  })

  it('does not call an unresolved tag compatible, and runs no codemods for it', async () => {
    const result = await upgradeCanary({
      cwd: workspace.dir,
      versionResolver: async () => null,
    })

    expect(result.versionCompatibility?.resolvedTarget).toBe(false)
    expect(result.versionCompatibility?.compatible).toBe(false)
    expect(result.versionCompatibility?.targetVersion).toBe('latest')
    expect(result.codemodResults).toHaveLength(0)
  })

  it('warns when the requested tag resolves to an older version', async () => {
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'downgrade-test',
        dependencies: { '@guren/core': '^1.3.0' },
      }, null, 2),
      'utf8',
    )

    const result = await upgradeCanary({
      cwd: workspace.dir,
      tag: 'rc',
      versionResolver: async () => '1.0.0-rc.26',
    })

    expect(result.versionCompatibility?.downgrade).toBe(true)
    expect(result.versionCompatibility?.compatible).toBe(false)
    expect(result.versionCompatibility?.warnings.join('\n')).toContain('would downgrade')
  })

  it('aligns drizzle pins with the version @guren/orm depends on', async () => {
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'drizzle-test',
        dependencies: { '@guren/orm': '^1.0.0', 'drizzle-orm': '1.0.0-rc.1' },
        devDependencies: { 'drizzle-kit': '1.0.0-rc.1' },
      }, null, 2),
      'utf8',
    )

    const result = await upgradeCanary({
      cwd: workspace.dir,
      versionResolver: async () => '1.2.0',
      manifestResolver: async (name) =>
        name === '@guren/orm'
          ? { version: '1.2.0', dependencies: { 'drizzle-orm': '1.0.0-rc.4' } }
          : { version: '1.0.0-rc.4' },
    })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }

    // Written exactly, matching how @guren/orm pins it — a caret would let the
    // app resolve a different copy than the adapter runs on.
    expect(packageJson.dependencies['drizzle-orm']).toBe('1.0.0-rc.4')
    expect(packageJson.devDependencies['drizzle-kit']).toBe('1.0.0-rc.4')
    expect(result.updatedDependencies).toContainEqual({
      field: 'dependencies',
      name: 'drizzle-orm',
      previousVersion: '1.0.0-rc.1',
      nextVersion: '1.0.0-rc.4',
    })
    expect(result.updatedDependencies).toContainEqual({
      field: 'devDependencies',
      name: 'drizzle-kit',
      previousVersion: '1.0.0-rc.1',
      nextVersion: '1.0.0-rc.4',
    })
  })

  // The rule's own refusals are covered in drizzle-pins.test.ts; only this layer
  // shows that one reaches the user instead of being swallowed.
  it('reports a pin it declined to move', async () => {
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'decline',
        dependencies: { '@guren/orm': '^1.0.0' },
        devDependencies: { 'drizzle-kit': '0.31.0' },
      }, null, 2),
      'utf8',
    )
    const warnings: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation(((message: unknown) => {
      warnings.push(String(message))
    }) as never)

    try {
      await upgradeCanary({
        cwd: workspace.dir,
        versionResolver: async () => '1.2.0',
        manifestResolver: async (name) =>
          name === '@guren/orm' ? { version: '1.2.0', dependencies: { 'drizzle-orm': '1.0.0-rc.4' } } : null,
      })
    } finally {
      warnSpy.mockRestore()
    }

    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<
      string,
      Record<string, string>
    >
    expect(packageJson.devDependencies?.['drizzle-kit']).toBe('0.31.0')
    expect(warnings.join('\n')).toContain('[guren upgrade] drizzle-kit@1.0.0-rc.4 does not exist on npm')
  })

  it('leaves the ORM manifest unread when the app pins no drizzle package', async () => {
    await writeFile(
      packageJsonPath,
      JSON.stringify({ name: 'no-drizzle', dependencies: { '@guren/orm': '^1.0.0' } }, null, 2),
      'utf8',
    )

    let looked = false
    await upgradeCanary({
      cwd: workspace.dir,
      versionResolver: async () => '1.2.0',
      manifestResolver: async () => {
        looked = true
        return null
      },
    })

    expect(looked).toBe(false)
  })

  it('makes no registry call for drizzle under the canary tag', async () => {
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'canary-drizzle',
        dependencies: { '@guren/orm': '^1.0.0', 'drizzle-orm': '1.0.0-rc.1' },
      }, null, 2),
      'utf8',
    )

    let looked = false
    await upgradeCanary({
      cwd: workspace.dir,
      tag: 'canary',
      manifestResolver: async () => {
        looked = true
        return null
      },
    })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
    }

    // canary keeps a floating pin, so there is nothing to converge on — and the
    // mode stays offline.
    expect(looked).toBe(false)
    expect(packageJson.dependencies['drizzle-orm']).toBe('1.0.0-rc.1')
  })

  it('resolves each package once even though it appears in several lookups', async () => {
    const calls: string[] = []
    await upgradeCanary({
      cwd: workspace.dir,
      versionResolver: async (name) => {
        calls.push(name)
        return '1.5.0'
      },
    })

    expect(calls).toEqual([...new Set(calls)])
  })

  it('leaves packages untouched when the registry lookup fails', async () => {
    const result = await upgradeCanary({
      cwd: workspace.dir,
      versionResolver: async () => null,
    })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
    }

    expect(result.updatedDependencies).toHaveLength(0)
    expect(packageJson.dependencies['@guren/core']).not.toBe('^null')
  })

  it('supports dry runs', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, dryRun: true , versionResolver: async () => '1.0.0-rc.99' })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
      scripts?: Record<string, string>
    }
    const tsconfig = JSON.parse(await readFile(join(workspace.dir, 'tsconfig.json'), 'utf8')) as {
      include: string[]
    }

    expect(result.updatedDependencies).toHaveLength(3)
    expect(result.autofixes.some((autofix) => autofix.applied)).toBe(false)
    expect(packageJson.dependencies['@guren/core']).toBe('^0.2.0-alpha.7')
    expect(packageJson.scripts?.build).toBeUndefined()
    expect(tsconfig.include).not.toContain('.guren/**/*')
  })

  it('supports disabling autofix', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, noAutofix: true, tag: 'canary' })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
      scripts?: Record<string, string>
    }
    const tsconfig = JSON.parse(await readFile(join(workspace.dir, 'tsconfig.json'), 'utf8')) as {
      include: string[]
    }

    expect(result.updatedDependencies).toHaveLength(3)
    expect(result.autofixes).toHaveLength(0)
    expect(result.warnings.some((warning) => warning.key === 'scripts')).toBe(true)
    expect(result.warnings.some((warning) => warning.key === 'tsconfig')).toBe(true)
    expect(packageJson.dependencies['@guren/core']).toBe('canary')
    expect(packageJson.scripts?.build).toBeUndefined()
    expect(tsconfig.include).not.toContain('.guren/**/*')
  })

  it('returns a stable json-shaped report', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, dryRun: true , versionResolver: async () => '1.0.0-rc.99' })

    expect(result).toHaveProperty('packageJsonPath')
    expect(result).toHaveProperty('updatedDependencies')
    expect(result).toHaveProperty('autofixes')
    expect(result).toHaveProperty('warnings')
    expect(result).toHaveProperty('manualSteps')
    expect(result).toHaveProperty('recommendedCommands')
    expect(Array.isArray(result.manualSteps)).toBe(true)
    expect(Array.isArray(result.recommendedCommands)).toBe(true)
  })

  it('runs install only when dependencies were updated', async () => {
    const installRunner = mock(async () => {})

    await upgradeCanary({ cwd: workspace.dir, install: true, installRunner , versionResolver: async () => '1.0.0-rc.99' })
    expect(installRunner).toHaveBeenCalledTimes(1)

    await upgradeCanary({ cwd: workspace.dir, install: true, installRunner , versionResolver: async () => '1.0.0-rc.99' })
    expect(installRunner).toHaveBeenCalledTimes(1)
  })

  it('includes deprecation and codemod results in output', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, dryRun: true , versionResolver: async () => '1.0.0-rc.99' })

    expect(result).toHaveProperty('deprecationWarnings')
    expect(result).toHaveProperty('codemodResults')
    expect(result).toHaveProperty('versionCompatibility')
    expect(Array.isArray(result.deprecationWarnings)).toBe(true)
    expect(Array.isArray(result.codemodResults)).toBe(true)
  })

  it('supports check-only mode without modifying files', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, checkOnly: true })
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
      dependencies: Record<string, string>
    }

    expect(result.updatedDependencies).toHaveLength(0)
    expect(result.autofixes).toHaveLength(0)
    expect(result.versionCompatibility).toBeDefined()
    expect(packageJson.dependencies['@guren/core']).toBe('^0.2.0-alpha.7')
  })
})

describe('checkVersionCompatibility', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-compat-')
    await writeFile(
      join(workspace.dir, 'package.json'),
      JSON.stringify({
        name: 'compat-test',
        dependencies: {
          '@guren/core': '^0.2.0',
        },
      }, null, 2),
      'utf8',
    )
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('returns current and target versions', async () => {
    const result = await checkVersionCompatibility(workspace.dir, 'canary')

    expect(result.currentVersion).toBe('0.2.0')
    expect(result.targetVersion).toBe('canary')
  })

  it('returns compatible when no warnings', async () => {
    const result = await checkVersionCompatibility(workspace.dir, 'canary')

    if (process.versions?.bun) {
      const bunMajor = parseInt(process.versions.bun.split('.')[0], 10)
      if (bunMajor >= 1) {
        expect(result.compatible).toBe(true)
        expect(result.warnings).toHaveLength(0)
      }
    }
  })

  it('skips pins that name a location instead of a release', async () => {
    await writeFile(
      join(workspace.dir, 'package.json'),
      JSON.stringify({
        name: 'compat-test',
        dependencies: {
          '@guren/server': 'workspace:*',
          '@guren/core': '^1.3.0',
        },
      }, null, 2),
      'utf8',
    )

    const result = await checkVersionCompatibility(workspace.dir, 'latest', async () => '1.3.0')

    // `workspace:*` comes first but cannot anchor a comparison, so the check
    // falls through to the next @guren/* pin that names a release.
    expect(result.currentVersion).toBe('1.3.0')
    expect(result.downgrade).toBe(false)
  })

  it('flags a resolved version older than the current pin', async () => {
    const result = await checkVersionCompatibility(workspace.dir, 'rc', async () => '0.1.0')

    expect(result.downgrade).toBe(true)
    expect(result.targetVersion).toBe('0.1.0')
    expect(result.warnings.join('\n')).toContain('older than')
  })

  it('leaves the tag in place when the registry lookup fails', async () => {
    const result = await checkVersionCompatibility(workspace.dir, 'latest', async () => null)

    expect(result.targetVersion).toBe('latest')
    expect(result.downgrade).toBe(false)
  })

  it('handles missing package.json gracefully', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const emptyDir = await mkdtemp(join(tmpdir(), 'guren-cli-empty-'))

    const result = await checkVersionCompatibility(emptyDir, 'canary')

    expect(result.compatible).toBe(true)
    expect(result.currentVersion).toBe('unknown')

    const { rm } = await import('node:fs/promises')
    await rm(emptyDir, { recursive: true, force: true })
  })
})

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('returns negative when first is less', () => {
    expect(compareVersions('0.2.0', '1.0.0')).toBeLessThan(0)
  })

  it('returns positive when first is greater', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBeGreaterThan(0)
  })

  it('compares patch versions correctly', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0)
  })

  // Guren shipped its entire 1.0 line as 1.0.0-rc.N, so prerelease precedence is
  // what the upgrade path actually compares.
  it('orders prereleases below their release, and numerically among themselves', () => {
    const ascending = ['1.0.0-alpha', '1.0.0-rc.1', '1.0.0-rc.1.1', '1.0.0-rc.4', '1.0.0-rc.29', '1.0.0', '1.0.1']

    for (const [index, lower] of ascending.entries()) {
      expect(compareVersions(lower, lower)).toBe(0)
      for (const higher of ascending.slice(index + 1)) {
        expect(compareVersions(lower, higher)).toBeLessThan(0)
        expect(compareVersions(higher, lower)).toBeGreaterThan(0)
      }
    }
  })

  it('ignores build metadata, which carries no precedence', () => {
    expect(compareVersions('1.0.0+foo', '1.0.0+bar')).toBe(0)
    expect(compareVersions('1.0.0-alpha+foo', '1.0.0-alpha+bar')).toBe(0)
    expect(compareVersions('1.5.0+build', '1.5.1')).toBeLessThan(0)
  })

  it('reports unordered for anything that is not one exact version', () => {
    // A partial pin is the dangerous one: Bun.semver ranks `1.3` *above*
    // `1.3.0`, which would read as a downgrade.
    for (const specifier of ['workspace:*', '^1.0.0', '1.3', 'latest', 'catalog:']) {
      expect(compareVersions(specifier, '1.0.0')).toBeNaN()
    }
  })
})

describe('findApplicableCodemods', () => {
  it('returns empty array when no codemods are registered', () => {
    const result = findApplicableCodemods('0.1.0', '1.0.0')
    expect(result).toHaveLength(0)
  })

  it('filters codemods by version range', () => {
    const testCodemods: Codemod[] = [
      {
        id: 'test-a',
        description: 'Test A',
        fromVersion: '0.2.0',
        toVersion: '0.3.0',
        async detect() { return [] },
        async apply() { return 0 },
      },
      {
        id: 'test-b',
        description: 'Test B',
        fromVersion: '0.5.0',
        toVersion: '1.0.0',
        async detect() { return [] },
        async apply() { return 0 },
      },
    ]

    codemods.push(...testCodemods)

    try {
      const result = findApplicableCodemods('0.1.0', '0.4.0')
      expect(result.some((c) => c.id === 'test-a')).toBe(true)
      expect(result.some((c) => c.id === 'test-b')).toBe(false)

      const resultAll = findApplicableCodemods('0.1.0', '1.0.0')
      expect(resultAll.some((c) => c.id === 'test-a')).toBe(true)
      expect(resultAll.some((c) => c.id === 'test-b')).toBe(true)
    } finally {
      codemods.splice(codemods.indexOf(testCodemods[0]), 1)
      codemods.splice(codemods.indexOf(testCodemods[1]), 1)
    }
  })
})

describe('checkDeprecations', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-deprec-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('returns empty array when no deprecations are registered', async () => {
    const result = await checkDeprecations(workspace.dir)
    expect(result).toHaveLength(0)
  })

  describe('seeder-class-convention', () => {
    async function writeFileIn(relativePath: string, contents: string): Promise<void> {
      const target = join(workspace.dir, relativePath)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, contents)
    }

    function seederWarning(warnings: Awaited<ReturnType<typeof checkDeprecations>>) {
      return warnings.find((warning) => warning.id === 'seeder-class-convention')
    }

    it('reports files importing the class-based seeder API', async () => {
      await writeFileIn(
        'db/seeders/LegacyUserSeeder.ts',
        "import { Seeder } from '@guren/core'\nexport default class LegacyUserSeeder extends Seeder {\n  async run(): Promise<void> {}\n}\n",
      )
      await writeFileIn(
        'app/Services/Runner.ts',
        "import { createSeederRunner } from '@guren/core'\nexport const runner = createSeederRunner()\n",
      )

      const warning = seederWarning(await checkDeprecations(workspace.dir))

      expect(warning).toBeDefined()
      expect(warning?.affectedFiles.sort()).toEqual([
        join('app', 'Services', 'Runner.ts'),
        join('db', 'seeders', 'LegacyUserSeeder.ts'),
      ])
    })

    // `defineSeeder` ends in the same six letters as `Seeder`, so a detector
    // matching the specifier as a substring reports every correct seeder.
    it('does not report a seeder written with defineSeeder', async () => {
      await writeFileIn(
        'db/seeders/001_users.ts',
        "import { defineSeeder } from '@guren/core'\nexport default defineSeeder(async ({ db }) => { void db })\n",
      )
      await writeFileIn(
        'app/Services/Seeding.ts',
        "import { defineSeeder, runSeeders } from '@guren/core'\nexport const helpers = [defineSeeder, runSeeders]\n",
      )

      expect(seederWarning(await checkDeprecations(workspace.dir))).toBeUndefined()
    })
  })
})
