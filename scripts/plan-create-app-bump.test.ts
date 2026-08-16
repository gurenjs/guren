import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { repoRoot } from './workspace-packages.ts'
import {
  MANAGED_CHANGESET,
  packagesTemplatesDeclare,
  planScaffolderBump,
  renderChangeset,
  type ReleasePlan,
} from './plan-create-app-bump.ts'

/**
 * The bump has to be conditional to be worth having: a script that always adds
 * `create-guren-app` to the plan would publish a tarball identical to the last
 * one on every deploy-plugin release, and would look exactly like a working one
 * from the release that needs the bump. So both directions are pinned here, and
 * the negative direction is checked against the *real* template manifests — a
 * mocked "declared" set would keep passing on the day a template starts
 * depending on the package the negative case names.
 */
const plan = (...names: string[]): ReleasePlan => ({
  releases: names.map((name) => ({ name, oldVersion: '1.0.0', newVersion: '1.0.1' })),
})

/** A package changesets pulled into the plan but left at its current version. */
const unmoved = (name: string) => ({ name, oldVersion: '1.0.0', newVersion: '1.0.0' })

describe('planScaffolderBump', () => {
  it('bumps the scaffolder when a package the templates declare is releasing', () => {
    expect(planScaffolderBump(plan('@guren/cli'), new Set(['@guren/cli']))).toEqual({
      bump: true,
      moving: ['@guren/cli'],
    })
  })

  it('lists every declared package that moves, and only those', () => {
    const decision = planScaffolderBump(
      plan('@guren/core', '@guren/plugin-cloudflare', '@guren/orm'),
      new Set(['@guren/core', '@guren/orm']),
    )

    expect(decision).toEqual({ bump: true, moving: ['@guren/core', '@guren/orm'] })
  })

  it('leaves a release the templates do not depend on alone', () => {
    expect(planScaffolderBump(plan('@guren/plugin-cloudflare'), new Set(['@guren/core']))).toEqual({
      bump: false,
      reason: 'templates-unaffected',
    })
  })

  /**
   * `changeset status` lists a package it pulled in but left alone with its
   * version unchanged — `@guren/example-blog` does this today, because it is the
   * one entry in the config's `ignore`. Such an entry rewrites no range, so a
   * name-only match here would bump the scaffolder into publishing a tarball
   * identical to the last one.
   */
  it('ignores a planned release that does not move a version', () => {
    expect(planScaffolderBump({ releases: [unmoved('@guren/orm')] }, new Set(['@guren/orm']))).toEqual({
      bump: false,
      reason: 'templates-unaffected',
    })
  })

  it('adds nothing when the scaffolder is already releasing', () => {
    expect(planScaffolderBump(plan('@guren/cli', 'create-guren-app'), new Set(['@guren/cli']))).toEqual({
      bump: false,
      reason: 'already-releasing',
    })
  })

  it('still bumps when the scaffolder is in the plan without moving', () => {
    const releases = [...plan('@guren/cli').releases, unmoved('create-guren-app')]

    expect(planScaffolderBump({ releases }, new Set(['@guren/cli']))).toEqual({
      bump: true,
      moving: ['@guren/cli'],
    })
  })

  it('distinguishes an empty plan from a plan that needs no bump', () => {
    expect(planScaffolderBump(plan(), new Set(['@guren/cli']))).toEqual({
      bump: false,
      reason: 'no-release',
    })
  })
})

describe('the packages the templates actually declare', () => {
  it('covers the framework packages a scaffolded app resolves from npm', async () => {
    const declared = await packagesTemplatesDeclare()

    // Not an exhaustive list: a template gaining a dependency is fine, and the
    // script reads the manifests rather than a list like this one. What would
    // not be fine is a template quietly dropping the packages whose versions
    // are the whole reason the scaffolder has to be republished.
    for (const name of ['@guren/cli', '@guren/core', '@guren/inertia-client', '@guren/orm', '@guren/testing']) {
      expect(declared.has(name)).toBe(true)
    }
  })

  it('does not declare the deploy plugins the negative case relies on', async () => {
    const declared = await packagesTemplatesDeclare()

    for (const plugin of ['@guren/plugin-cloudflare', '@guren/plugin-lambda', '@guren/plugin-vercel']) {
      expect(declared.has(plugin)).toBe(false)
    }
  })
})

/**
 * The script's whole value is in being invoked, and ahead of `changeset
 * version` — behind it, the plan it reads is already spent. Nothing else here
 * would notice it being dropped from the release command: every unit test above
 * keeps passing, and the release goes back to being refused by
 * `sync-template-deps --release` with a human writing the changeset by hand,
 * which is the state this exists to leave.
 */
describe('the version-packages wiring', () => {
  const versionPackages = (
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
  ).scripts['version-packages']

  it('runs the planner before changeset version', () => {
    const planner = versionPackages.indexOf('plan-create-app-bump')
    const version = versionPackages.indexOf('changeset version')

    expect(planner).toBeGreaterThanOrEqual(0)
    expect(version).toBeGreaterThanOrEqual(0)
    expect(planner).toBeLessThan(version)
  })

  it('still runs the sync gate that refuses a release without the bump', () => {
    expect(versionPackages).toContain('sync-template-deps.ts --release')
  })
})

describe('renderChangeset', () => {
  it('bumps create-guren-app by a patch and names what is releasing', () => {
    const body = renderChangeset(['@guren/cli', '@guren/orm'])

    expect(body.split('\n').slice(0, 3)).toEqual(['---', '"create-guren-app": patch', '---'])
    expect(body).toContain('`@guren/cli`, `@guren/orm`')
    expect(body.endsWith('\n')).toBe(true)
  })

  it('is written where changesets will pick it up', () => {
    expect(MANAGED_CHANGESET.startsWith('.changeset/')).toBe(true)
    expect(MANAGED_CHANGESET.endsWith('.md')).toBe(true)
  })
})
