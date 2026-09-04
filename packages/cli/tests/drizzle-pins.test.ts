import { describe, expect, it } from 'bun:test'
import {
  needsDrizzleAlignment,
  planDrizzlePins,
  type DependencyManifest,
  type DrizzlePinDecline,
  type DrizzlePinOptions,
  type OrmManifest,
} from '../src/drizzle-pins'

const ORM: OrmManifest = { version: '1.3.0', dependencies: { 'drizzle-orm': '1.0.0-rc.4' } }

/** Every companion release exists — the branch that is not under test here. */
const anyPublished = async () => true

async function plan(
  manifest: DependencyManifest,
  options: Partial<DrizzlePinOptions> = {},
  orm: OrmManifest = ORM,
): Promise<{ planned: Awaited<ReturnType<typeof planDrizzlePins>>; declines: DrizzlePinDecline[] }> {
  const declines: DrizzlePinDecline[] = []
  const planned = await planDrizzlePins(manifest, orm, {
    companionPublished: anyPublished,
    onDecline: (decline) => declines.push(decline),
    ...options,
  })
  return { planned, declines }
}

describe('planDrizzlePins', () => {
  it('pins both drizzle packages to the version @guren/orm depends on', async () => {
    const { planned } = await plan({
      dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.1' },
      devDependencies: { 'drizzle-kit': '1.0.0-rc.1' },
    })

    // Exactly, matching how @guren/orm pins it — a caret would let the manifest
    // resolve a different copy than the adapter runs on.
    expect(planned).toEqual([
      { field: 'dependencies', name: 'drizzle-orm', previousVersion: '1.0.0-rc.1', nextVersion: '1.0.0-rc.4' },
      { field: 'devDependencies', name: 'drizzle-kit', previousVersion: '1.0.0-rc.1', nextVersion: '1.0.0-rc.4' },
    ])
  })

  it('plans nothing when the manifest is already aligned, without asking the registry', async () => {
    let asked = false
    const { planned } = await plan(
      {
        dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.4' },
        devDependencies: { 'drizzle-kit': '1.0.0-rc.4' },
      },
      {
        companionPublished: async () => {
          asked = true
          return true
        },
      },
    )

    // The steady state is what CI runs on every PR; it must stay offline.
    expect(planned).toEqual([])
    expect(asked).toBe(false)
  })

  it('leaves the pin source alone: peerDependencies installs no copy to dedupe', async () => {
    const { planned, declines } = await plan({
      dependencies: { '@guren/orm': '^1.3.0' },
      peerDependencies: { 'drizzle-orm': '^1' },
    })

    expect(planned).toEqual([])
    expect(declines).toEqual([])
  })

  it('asks about the companion once, however many fields declare it', async () => {
    const asked: string[] = []
    await plan(
      {
        dependencies: { '@guren/orm': '^1.3.0', 'drizzle-kit': '1.0.0-rc.1' },
        devDependencies: { 'drizzle-kit': '1.0.0-rc.1' },
      },
      {
        companionPublished: async (name, version) => {
          asked.push(`${name}@${version}`)
          return true
        },
      },
    )

    expect(asked).toEqual(['drizzle-kit@1.0.0-rc.4'])
  })

  it('never asks about the pin source itself', async () => {
    const asked: string[] = []
    await plan(
      { dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.1', 'drizzle-kit': '1.0.0-rc.1' } },
      {
        companionPublished: async (name, version) => {
          asked.push(`${name}@${version}`)
          return true
        },
      },
    )

    // The pin came from @guren/orm's own dependency on it, so that release
    // necessarily exists.
    expect(asked).toEqual(['drizzle-kit@1.0.0-rc.4'])
  })

  // Every refusal, with the entry it leaves behind and the reason a caller
  // acts on.
  const declined = [
    {
      label: 'a specifier that names a location',
      manifest: { dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': 'workspace:*' } },
      options: {},
      orm: ORM,
      reason: 'location-specifier',
      message: 'names a location rather than a release',
      untouched: 'drizzle-orm',
    },
    {
      label: 'a companion release that was never published',
      manifest: {
        dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.1' },
        devDependencies: { 'drizzle-kit': '0.31.0' },
      },
      options: { companionPublished: async (name: string) => name !== 'drizzle-kit' },
      orm: ORM,
      reason: 'companion-unpublished',
      message: 'does not exist on npm',
      untouched: 'drizzle-kit',
    },
    {
      label: 'a registry that will not answer',
      manifest: {
        dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.1' },
        devDependencies: { 'drizzle-kit': '0.31.0' },
      },
      options: {
        companionPublished: async () => {
          throw new Error('npm returned 503')
        },
      },
      orm: ORM,
      reason: 'companion-unverifiable',
      message: 'Could not ask npm whether',
      untouched: 'drizzle-kit',
    },
    {
      label: 'an ORM that depends on a range rather than one version',
      manifest: { dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.1' } },
      options: {},
      orm: { version: '1.3.0', dependencies: { 'drizzle-orm': '^1.0.0' } },
      reason: 'no-exact-pin',
      message: 'not a single exact version',
      untouched: 'drizzle-orm',
    },
    {
      label: 'an ORM manifest that declares no drizzle dependency at all',
      manifest: { dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.1' } },
      options: {},
      orm: { version: '1.3.0', dependencies: {} },
      reason: 'no-exact-pin',
      message: 'Could not read the drizzle-orm version',
      untouched: 'drizzle-orm',
    },
  ] as const

  for (const { label, manifest, options, orm, reason, message, untouched } of declined) {
    it(`declines ${label}, and says which refusal it was`, async () => {
      const { planned, declines } = await plan(manifest, options, orm)

      // The reason is what the caller acts on: `guren upgrade` reports all of
      // them, the template sync fails on the ones it could fix in-repo.
      expect(declines.map((decline) => decline.reason)).toContain(reason)
      expect(declines.map((decline) => decline.message).join('\n')).toContain(message)
      expect(planned.map((change) => change.name)).not.toContain(untouched)
    })
  }

  it('still moves the pin source when only the companion is refused', async () => {
    const { planned } = await plan(
      {
        dependencies: { '@guren/orm': '^1.3.0', 'drizzle-orm': '1.0.0-rc.1' },
        devDependencies: { 'drizzle-kit': '0.31.0' },
      },
      { companionPublished: async (name: string) => name !== 'drizzle-kit' },
    )

    // The two are aligned with the ORM, not with each other, and they have never
    // shared numbers on their stable lines.
    expect(planned).toEqual([
      { field: 'dependencies', name: 'drizzle-orm', previousVersion: '1.0.0-rc.1', nextVersion: '1.0.0-rc.4' },
    ])
  })
})

describe('needsDrizzleAlignment', () => {
  it('is false for a manifest that pins drizzle without using @guren/orm', () => {
    // Nothing installs a second copy, so there is no duplicate to avoid and no
    // reason to drag the manifest onto the ORM's pin.
    expect(needsDrizzleAlignment({ dependencies: { '@guren/core': '^1.4.0', 'drizzle-orm': '1.0.0-rc.1' } })).toBe(false)
  })

  it('is false for an empty @guren/orm specifier, which declares nothing', () => {
    expect(needsDrizzleAlignment({ dependencies: { '@guren/orm': '', 'drizzle-orm': '1.0.0-rc.1' } })).toBe(false)
  })

  it('is false for a manifest that uses @guren/orm without pinning drizzle', () => {
    expect(needsDrizzleAlignment({ dependencies: { '@guren/orm': '^1.3.0' } })).toBe(false)
  })

  it('sees a @guren/orm declared in any field', () => {
    expect(
      needsDrizzleAlignment({
        peerDependencies: { '@guren/orm': '^1.3.0' },
        devDependencies: { 'drizzle-kit': '1.0.0-rc.1' },
      }),
    ).toBe(true)
  })
})
