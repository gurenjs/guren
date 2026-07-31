import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppBlueprint } from '../src/blueprints'
import {
  TEMPLATES_ROOT,
  assertBlueprintLayersExist,
  getAppBlueprint,
  listAppBlueprints,
  listBlueprintTemplates,
  templateDir,
} from '../src/blueprints'
import { directoryExists } from '../src/utils'

/**
 * Invariant and the bug behind it: see TEMPLATES_ROOT in src/blueprints.ts.
 * `TemplateName` now makes an out-of-package layer a compile error, so what is
 * left to check at runtime is that the directories those names point at are
 * really published.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('blueprint template packaging', () => {
  it('publishes the directory every template lives in', async () => {
    const raw = await readFile(join(packageRoot, 'package.json'), 'utf8')
    const { files = [] } = JSON.parse(raw) as { files?: string[] }

    expect(files).toContain(relative(packageRoot, TEMPLATES_ROOT))
  })

  it.each(listAppBlueprints())('ships every %s template on disk', async (blueprint) => {
    const templates = listBlueprintTemplates(getAppBlueprint(blueprint))

    // A blueprint with no template at all would vacuously pass the loop below.
    expect(templates.length).toBeGreaterThan(0)

    for (const template of templates) {
      expect(await directoryExists(templateDir(template))).toBe(true)
    }
  })
})

describe('missing template directory', () => {
  // The type forbids naming a template that does not exist, so a corrupt
  // install — the case this guard is for — has to be forged past it.
  const corruptInstall = {
    ...getAppBlueprint('default'),
    baseTemplate: 'does-not-exist',
  } as unknown as AppBlueprint

  it('names the blueprint, the path, and what the user can do', async () => {
    const error = await assertBlueprintLayersExist(corruptInstall, 'ssr').catch((caught: unknown) => caught as Error)

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('does-not-exist')
    expect(error?.message).toContain('"default"')
    expect(error?.message).toContain('github.com/gurenjs/guren/issues')
    // A raw fs failure would surface as ENOENT and name lstat, not the blueprint.
    expect(error?.message).not.toContain('ENOENT')
  })

  it('rejects a missing overlay even when the base template exists', async () => {
    const badOverlay = {
      ...getAppBlueprint('default'),
      overlayTemplates: { ssr: ['does-not-exist'] },
    } as unknown as AppBlueprint

    await expect(assertBlueprintLayersExist(badOverlay, 'ssr')).rejects.toThrow(/does-not-exist/u)
  })
})
