import { describe, expect, it } from 'bun:test'
import { RELEASE_AGE_SECONDS, renderTemplateBunfig, youngRanges, type Packument } from './template-cooldown'

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

describe('renderTemplateBunfig', () => {
  it('writes the gate and every exclusion by exact name', () => {
    const bunfig = renderTemplateBunfig(['@guren/core', '@guren/server'])

    expect(bunfig).toContain(`[install]\nminimumReleaseAge = ${RELEASE_AGE_SECONDS}\n`)
    expect(bunfig).toContain('minimumReleaseAgeExcludes = [\n  "@guren/core",\n  "@guren/server",\n]\n')
    expect(Bun.TOML.parse(bunfig)).toEqual({
      install: { minimumReleaseAge: 259_200, minimumReleaseAgeExcludes: ['@guren/core', '@guren/server'] },
    })
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

    expect(young).toHaveLength(1)
    expect(young[0]!.reason).toBe(
      `the oldest version it admits, 3.11.0, was published ${daysAgo(1)} and clears the gate at ${new Date(NOW + 2 * DAY).toISOString()}`,
    )
  })

  it('treats a version exactly as old as the gate as cleared', async () => {
    const { fetch } = registry({ zod: { versions: { '4.6.7': {} }, time: { '4.6.7': daysAgo(3) } } })

    expect(await youngRanges([{ name: 'zod', range: '4.6.7', source }], fetch, NOW)).toEqual([])
  })

  it('reports a range no published version satisfies', async () => {
    const { fetch } = registry({ zod: { versions: { '4.6.7': {} }, time: { '4.6.7': daysAgo(30) } } })

    const young = await youngRanges([{ name: 'zod', range: '^5.0.0', source }], fetch, NOW)

    expect(young.map((entry) => entry.reason)).toEqual(['no published version satisfies it'])
  })

  it('reports a range whose package the registry could not return, never passing it', async () => {
    const { fetch } = registry({})

    const young = await youngRanges([{ name: 'missing', range: '^1.0.0', source }], fetch, NOW)

    expect(young[0]!.reason).toBe('the registry did not answer (npm answered 404)')
  })

  it('reports a range without publish times for what it admits', async () => {
    const { fetch } = registry({ odd: { versions: { '1.0.0': {} } } })

    const young = await youngRanges([{ name: 'odd', range: '^1.0.0', source }], fetch, NOW)

    expect(young[0]!.reason).toBe('the registry gives no publish time for the versions it admits')
  })

  it('reports a dist-tag or a location without asking the registry', async () => {
    const { fetch, asked } = registry({})

    const young = await youngRanges([
      { name: 'a', range: 'latest', source },
      { name: 'b', range: 'npm:other@^1.0.0', source },
      { name: 'c', range: 'github:owner/repo', source },
    ], fetch, NOW)

    expect(young).toHaveLength(3)
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
