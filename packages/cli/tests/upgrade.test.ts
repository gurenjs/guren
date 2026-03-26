import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { upgradeCanary } from '../src/upgrade'

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
})
