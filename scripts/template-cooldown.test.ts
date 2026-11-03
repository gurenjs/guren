import { describe, expect, it } from 'bun:test'
import { templateManifests } from '../packages/create-app/src/blueprints'
import {
  cooldownExclusions,
  isSemverRange,
  scaffoldThirdPartyRanges,
  youngRanges,
  type Packument,
} from './template-cooldown'

const DAY = 86_400_000
const NOW = Date.parse('2026-11-10T00:00:00.000Z')
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString()

function registry(packuments: Record<string, Packument>) {
  const asked: string[] = []
  return {
    asked,
    fetch: async (name: string) => {
      asked.push(name)
      const packument = packuments[name]
      if (!packument) throw new Error('npm answered 404')
      return packument
    },
  }
}

describe('cooldownExclusions', () => {
  it('lists every published @guren package, plugins included, and nothing else', async () => {
    const excludes = await cooldownExclusions()

    expect(excludes).toContain('@guren/server')
    expect(excludes).toContain('@guren/plugin-ai')
    expect(excludes.every((name) => name.startsWith('@guren/'))).toBe(true)
    expect(excludes).toEqual([...excludes].sort((a, b) => a.localeCompare(b)))
  })
})

describe('scaffoldThirdPartyRanges', () => {
  it('reads the templates, the database drivers, guren add ai and the scaffolded @guren packages', async () => {
    const ranges = await scaffoldThirdPartyRanges(await templateManifests())
    const sources = (name: string) => ranges.filter((entry) => entry.name === name).map((entry) => entry.source)

    expect(sources('postgres')).toContain('create-guren-app --db postgres')
    expect(sources('mysql2')).toContain('create-guren-app --db mysql')
    expect(sources('ai')).toContain('guren add ai')
    expect(sources('@ai-sdk/anthropic')).toEqual(['guren add ai'])
    expect(sources('hono')).toContain('@guren/server')
    expect(ranges.some((entry) => entry.name.startsWith('@guren/'))).toBe(false)
  })
})

describe('isSemverRange', () => {
  it.each(['^1.0.0-rc.4', '1.0.0-rc.4', '>=1.2.0 <2', '1 || 2', '1.2.3 - 2.3.4', '*', 'x', '1.x', '~4.6', ''])('reads %p as a range', (range) => {
    expect(isSemverRange(range)).toBe(true)
  })

  it.each(['next-15', 'beta2', 'latest', 'canary.1', 'ts5.9'])('reads %p as something else', (range) => {
    expect(isSemverRange(range)).toBe(false)
  })
})

describe('youngRanges', () => {
  const source = 'templates/default/package.json'

  it('passes a range that admits a version older than the gate', async () => {
    const { fetch } = registry({
      hono: { versions: { '4.13.12': {}, '4.13.13': {} }, time: { '4.13.12': daysAgo(10), '4.13.13': daysAgo(1) } },
    })

    expect(await youngRanges([{ name: 'hono', range: '^4.13.12', source }], fetch, NOW)).toEqual([])
  })

  it('reports a range only versions younger than the gate satisfy, with when it clears', async () => {
    const { fetch } = registry({
      '@inertiajs/react': { versions: { '3.10.0': {}, '3.11.0': {} }, time: { '3.10.0': daysAgo(20), '3.11.0': daysAgo(1) } },
    })

    const young = await youngRanges([{ name: '@inertiajs/react', range: '^3.11.0', source }], fetch, NOW)

    expect(young.map((entry) => entry.reason)).toEqual([
      `the oldest version it admits, 3.11.0, was published ${daysAgo(1)} and clears the gate at ${new Date(NOW + 2 * DAY).toISOString()}`,
    ])
  })

  it('treats a version exactly as old as the gate as cleared', async () => {
    const { fetch } = registry({ zod: { versions: { '4.6.7': {} }, time: { '4.6.7': daysAgo(3) } } })

    expect(await youngRanges([{ name: 'zod', range: '4.6.7', source }], fetch, NOW)).toEqual([])
  })

  it('passes a version with no publish time, as Bun does', async () => {
    const { fetch } = registry({ odd: { versions: { '1.0.0': {} } } })

    expect(await youngRanges([{ name: 'odd', range: '^1.0.0', source }], fetch, NOW)).toEqual([])
  })

  it('judges a dist-tag by the one version it names', async () => {
    const { fetch } = registry({
      next: {
        'dist-tags': { 'next-15': '15.1.0' },
        versions: { '14.0.0': {}, '15.1.0': {} },
        time: { '14.0.0': daysAgo(200), '15.1.0': daysAgo(1) },
      },
    })

    const young = await youngRanges([{ name: 'next', range: 'next-15', source }], fetch, NOW)

    expect(young).toHaveLength(1)
    expect(young[0]!.reason).toContain('15.1.0')
  })

  it('reports a specifier that is neither a range nor a dist-tag', async () => {
    const { fetch } = registry({ pkg: { versions: { '1.0.0': {} }, time: { '1.0.0': daysAgo(30) } } })

    const young = await youngRanges([{ name: 'pkg', range: 'beta2', source }], fetch, NOW)

    expect(young.map((entry) => entry.reason)).toEqual(['beta2 is neither a semver range nor a dist-tag of pkg'])
  })

  it('reports a range no published version satisfies', async () => {
    const { fetch } = registry({ zod: { versions: { '4.6.7': {} }, time: { '4.6.7': daysAgo(30) } } })

    const young = await youngRanges([{ name: 'zod', range: '^5.0.0', source }], fetch, NOW)

    expect(young.map((entry) => entry.reason)).toEqual(['no published version satisfies it'])
  })

  it('reports a range whose package the registry could not return, never passing it', async () => {
    const { fetch } = registry({})

    const young = await youngRanges([{ name: 'missing', range: '^1.0.0', source }], fetch, NOW)

    expect(young.map((entry) => entry.reason)).toEqual(['the registry did not answer (npm answered 404)'])
  })

  it('reports a location without asking the registry', async () => {
    const { fetch, asked } = registry({})

    const young = await youngRanges([
      { name: 'b', range: 'npm:other@^1.0.0', source },
      { name: 'c', range: 'github:owner/repo', source },
    ], fetch, NOW)

    expect(young).toHaveLength(2)
    expect(asked).toEqual([])
  })

  it('asks the registry once per package', async () => {
    const { fetch, asked } = registry({ hono: { versions: { '4.13.12': {} }, time: { '4.13.12': daysAgo(10) } } })

    await youngRanges([
      { name: 'hono', range: '^4.13.12', source },
      { name: 'hono', range: '^4.13.0', source: '@guren/server' },
    ], fetch, NOW)

    expect(asked).toEqual(['hono'])
  })
})
