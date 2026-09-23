import { describe, expect, it } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppBlueprint, listAppBlueprints, listBlueprintTemplates, templateDir } from '../src/blueprints'

/**
 * `AppBlueprint.apiOnly` and the api next steps in src/cli.ts mirror @guren/cli,
 * which this package cannot import (the CLI is installed into the scaffolded app):
 * the API-only evidence `isConfirmedApiOnlyApp()` reads, and the alternatives its
 * `add auth` / `add resource` refusals name. The CLI side is read as source text.
 */

async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), 'utf8')
}

function extract(source: string, pattern: RegExp, what: string): string {
  const match = source.match(pattern)
  if (!match) {
    throw new Error(`Could not find ${what}`)
  }
  return match[1]!
}

async function layerDependsOnInertiaClient(layerDir: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(join(layerDir, 'package.json'), 'utf8')
  } catch {
    return false
  }
  const manifest = JSON.parse(raw) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return Boolean(manifest.dependencies?.['@guren/inertia-client'] ?? manifest.devDependencies?.['@guren/inertia-client'])
}

async function layerHasWebRoutes(layerDir: string): Promise<boolean> {
  try {
    await access(join(layerDir, 'routes/web.ts'))
    return true
  } catch {
    return false
  }
}

describe('API-only mirror', () => {
  it('marks exactly the blueprints whose layers carry no Inertia evidence as apiOnly', async () => {
    const appSurface = await readSource('../../cli/src/app-surface.ts')
    const routeRegistrar = await readSource('../../cli/src/route-registrar.ts')
    expect(appSurface).toContain('@guren/inertia-client')
    expect(routeRegistrar).toContain(`DEFAULT_ROUTES_FILE = 'routes/web.ts'`)

    for (const name of listAppBlueprints()) {
      const blueprint = getAppBlueprint(name)
      const layers = listBlueprintTemplates(blueprint).map((layer) => templateDir(layer))
      const evidence = await Promise.all(
        layers.map(async (layer) => (await layerDependsOnInertiaClient(layer)) || (await layerHasWebRoutes(layer))),
      )
      expect({ name, apiOnly: Boolean(blueprint.apiOnly) }).toEqual({ name, apiOnly: !evidence.includes(true) })
    }
  })

  it('names the alternatives the add auth and add resource refusals give', async () => {
    const createApp = await readSource('../src/cli.ts')
    const makeAuth = await readSource('../../cli/src/make-auth.ts')
    const cliBlueprints = await readSource('../../cli/src/blueprints.ts')
    const makeFeature = await readSource('../../cli/src/make-feature.ts')

    const authInstead = extract(
      makeAuth,
      /assertNotApiOnly\(process\.cwd\(\), \{[^}]*?instead: '([^']+)'/u,
      'the instead of the assertNotApiOnly call in packages/cli/src/make-auth.ts',
    )
    expect(createApp).toContain(authInstead)

    expect(cliBlueprints).toContain('instead: API_ONLY_FEATURE_ALTERNATIVE')
    const featureAlternative = extract(
      makeFeature,
      /export const API_ONLY_FEATURE_ALTERNATIVE = '([^']+)'/u,
      'API_ONLY_FEATURE_ALTERNATIVE in packages/cli/src/make-feature.ts',
    )
    const featureHint = extract(
      createApp,
      /consola\.log\('(\s*bunx guren make:controller[^']*)'\)/u,
      'the make:controller hint in packages/create-app/src/cli.ts',
    )
    for (const text of [featureAlternative, featureHint]) {
      expect(text).toContain('make:controller')
      expect(text).toContain('routes/api.ts')
    }
  })
})
