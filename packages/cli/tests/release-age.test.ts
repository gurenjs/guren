import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDoctorRuleEvaluations } from '../src/doctor'
import {
  RELEASE_AGE_SECONDS,
  addExclusions,
  appGurenPackages,
  missingExclusions,
  readReleaseAge,
  renderReleaseAgeBunfig,
  type ReleaseAgeReading,
} from '../src/release-age'
import { createTempWorkspace, type TempWorkspace } from './helpers'

describe('renderReleaseAgeBunfig', () => {
  it('writes the gate and each exclusion by name, in the days the constant gives', () => {
    const bunfig = renderReleaseAgeBunfig(['@guren/core', '@guren/server'])

    expect(bunfig).toContain('ago (3 days)')
    expect(readReleaseAge(bunfig)).toEqual({ kind: 'on', seconds: RELEASE_AGE_SECONDS, excludes: ['@guren/core', '@guren/server'] })
  })
})

describe('readReleaseAge', () => {
  const readings: Array<[string | undefined, ReleaseAgeReading]> = [
    [undefined, { kind: 'missing-file' }],
    ['', { kind: 'no-install-table' }],
    ['[test]\npreload = ["./setup.ts"]\n', { kind: 'no-install-table' }],
    ['[install]\nauto = "disable"\n', { kind: 'no-gate' }],
    ['[install]\nminimumReleaseAge = 0\n', { kind: 'off' }],
    ['[install]\nminimumReleaseAge = 604800\n', { kind: 'on', seconds: 604_800, excludes: [] }],
  ]

  it.each(readings)('reads %p', (text, expected) => {
    expect(readReleaseAge(text)).toEqual(expected)
  })

  it.each([
    '[install\n',
    'install = 3\n',
    '[install]\nminimumReleaseAge = "3d"\n',
    '[install]\nminimumReleaseAge = -1\n',
    '[install]\nminimumReleaseAge = 10\nminimumReleaseAgeExcludes = "@guren/core"\n',
  ])('reports %p as unreadable rather than judging it', (text) => {
    expect(readReleaseAge(text).kind).toBe('unreadable')
  })
})

describe('missingExclusions', () => {
  it('does not count a name@version entry as the package', () => {
    expect(missingExclusions(['@guren/core', '@guren/orm@2.15.0'], ['@guren/core', '@guren/orm'])).toEqual(['@guren/orm'])
  })
})

describe('addExclusions', () => {
  it('adds names inside the one-entry-per-line list the scaffold writes', () => {
    const patched = addExclusions(renderReleaseAgeBunfig(['@guren/core']), ['@guren/plugin-ai'])

    expect(patched).not.toBeNull()
    expect(readReleaseAge(patched!)).toEqual({ kind: 'on', seconds: RELEASE_AGE_SECONDS, excludes: ['@guren/core', '@guren/plugin-ai'] })
  })

  it('leaves a list written any other way to the author', () => {
    expect(addExclusions('[install]\nminimumReleaseAge = 10\nminimumReleaseAgeExcludes = ["@guren/core"]\n', ['@guren/orm'])).toBeNull()
  })

  it('leaves a file with two such lists to the author', () => {
    const twice = `${renderReleaseAgeBunfig(['@guren/core'])}\n[other]\n${renderReleaseAgeBunfig(['@guren/core']).split('[install]\n')[1]}`

    expect(addExclusions(twice, ['@guren/orm'])).toBeNull()
  })
})

describe('supply-chain-cooldown', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-release-age-')
    await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({
      name: 'app',
      dependencies: { '@guren/core': '^1.26.0' },
      devDependencies: { '@guren/testing': '^1.14.3' },
    }), 'utf8')
    await mkdir(join(workspace.dir, 'node_modules', '@guren', 'server'), { recursive: true })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  async function evaluate() {
    const { evaluations } = await getDoctorRuleEvaluations({ cwd: workspace.dir })
    const evaluation = evaluations.find((entry) => entry.check.key === 'supply-chain-cooldown')
    if (!evaluation) throw new Error('supply-chain-cooldown did not run')
    return evaluation
  }

  const bunfig = () => readFile(join(workspace.dir, 'bunfig.toml'), 'utf8')

  it('names the packages an app declares or has installed', async () => {
    expect(await appGurenPackages(workspace.dir)).toEqual(['@guren/core', '@guren/server', '@guren/testing'])
  })

  it('writes the scaffold block when the app has no bunfig.toml', async () => {
    await rm(join(workspace.dir, 'bunfig.toml'))

    const evaluation = await evaluate()
    expect(evaluation.check.status).toBe('warn')
    expect(evaluation.check.canAutofix).toBe(true)
    await evaluation.autofix!.apply(workspace.dir)

    expect(await bunfig()).toBe(renderReleaseAgeBunfig(['@guren/core', '@guren/server', '@guren/testing']))
    expect((await evaluate()).check.status).toBe('pass')
  })

  it('appends the block below the tables a bunfig.toml without [install] already has', async () => {
    await writeFile(join(workspace.dir, 'bunfig.toml'), '[test]\npreload = ["./setup.ts"]', 'utf8')

    await (await evaluate()).autofix!.apply(workspace.dir)

    const text = await bunfig()
    expect(text.startsWith('[test]\npreload = ["./setup.ts"]\n\n# Bun skips')).toBe(true)
    expect((await evaluate()).check.status).toBe('pass')
  })

  it('asks the author to edit an [install] table it did not write', async () => {
    await writeFile(join(workspace.dir, 'bunfig.toml'), '[install]\nauto = "disable"\n', 'utf8')

    const evaluation = await evaluate()

    expect(evaluation.check.status).toBe('warn')
    expect(evaluation.check.canAutofix).toBeFalsy()
    expect(evaluation.autofix).toBeFalsy()
    expect(evaluation.check.manualFix).toContain(`minimumReleaseAge = ${RELEASE_AGE_SECONDS}`)
  })

  it('adds the @guren packages the exclusions leave out', async () => {
    await writeFile(join(workspace.dir, 'bunfig.toml'), renderReleaseAgeBunfig(['@guren/core']), 'utf8')

    const evaluation = await evaluate()
    expect(evaluation.check.message).toContain('@guren/server, @guren/testing')
    await evaluation.autofix!.apply(workspace.dir)

    expect(await bunfig()).toBe(renderReleaseAgeBunfig(['@guren/core', '@guren/server', '@guren/testing']))
  })

  it('passes a gate the author turned off', async () => {
    await writeFile(join(workspace.dir, 'bunfig.toml'), '[install]\nminimumReleaseAge = 0\n', 'utf8')

    expect((await evaluate()).check.status).toBe('pass')
  })

  it('does not judge a bunfig.toml it cannot parse', async () => {
    await writeFile(join(workspace.dir, 'bunfig.toml'), '[install\n', 'utf8')

    const evaluation = await evaluate()

    expect(evaluation.check.status).toBe('warn')
    expect(evaluation.check.message).toContain('could not be read')
    expect(evaluation.autofix).toBeFalsy()
  })
})
