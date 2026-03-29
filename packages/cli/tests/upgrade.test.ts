import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { upgradeCanary, checkVersionCompatibility } from '../src/upgrade'
import { findApplicableCodemods, compareVersions, codemods, type Codemod } from '../src/codemods'
import { checkDeprecations, deprecations } from '../src/deprecations'

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
    const result = await upgradeCanary({ cwd: workspace.dir })
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

  it('supports dry runs', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, dryRun: true })
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
    const result = await upgradeCanary({ cwd: workspace.dir, noAutofix: true })
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
    const result = await upgradeCanary({ cwd: workspace.dir, dryRun: true })

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

    await upgradeCanary({ cwd: workspace.dir, install: true, installRunner })
    expect(installRunner).toHaveBeenCalledTimes(1)

    await upgradeCanary({ cwd: workspace.dir, install: true, installRunner })
    expect(installRunner).toHaveBeenCalledTimes(1)
  })

  it('includes deprecation and codemod results in output', async () => {
    const result = await upgradeCanary({ cwd: workspace.dir, dryRun: true })

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

    // On modern Bun (>= 1.0.0) this should be compatible
    if (process.versions?.bun) {
      const bunMajor = parseInt(process.versions.bun.split('.')[0], 10)
      if (bunMajor >= 1) {
        expect(result.compatible).toBe(true)
        expect(result.warnings).toHaveLength(0)
      }
    }
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

    // Temporarily add test codemods
    codemods.push(...testCodemods)

    try {
      // Upgrading from 0.1.0 to 0.4.0 should include test-a but not test-b
      const result = findApplicableCodemods('0.1.0', '0.4.0')
      expect(result.some((c) => c.id === 'test-a')).toBe(true)
      expect(result.some((c) => c.id === 'test-b')).toBe(false)

      // Upgrading from 0.1.0 to 1.0.0 should include both
      const resultAll = findApplicableCodemods('0.1.0', '1.0.0')
      expect(resultAll.some((c) => c.id === 'test-a')).toBe(true)
      expect(resultAll.some((c) => c.id === 'test-b')).toBe(true)
    } finally {
      // Clean up: remove test codemods
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
})
