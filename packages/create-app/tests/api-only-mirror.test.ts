import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isConfirmedApiOnlyApp } from '../../cli/src/app-surface'
import { getAppBlueprint, listAppBlueprints, scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace } from './helpers'

/**
 * `apiOnly` is judged by @guren/cli's own `isConfirmedApiOnlyApp()`, imported.
 * The refusal alternatives the api next steps repeat are read as text instead:
 * make-auth.ts does not export its alternative, and importing make-feature.ts
 * pulls in every generator module.
 */

async function readCliSource(file: string): Promise<string> {
  return readFile(new URL(`../../cli/src/${file}`, import.meta.url), 'utf8')
}

describe('API-only mirror', () => {
  it.each(listAppBlueprints())('marks the %s blueprint apiOnly exactly when @guren/cli reads it as API-only', async (name) => {
    const blueprint = getAppBlueprint(name)
    const workspace = await createTempWorkspace(`guren-api-only-mirror-${name}-`)
    try {
      const destination = join(workspace.dir, 'app')
      await scaffoldAppBlueprint({ blueprint: name, destination, renderingMode: 'spa', database: 'sqlite' })

      expect({ name, apiOnly: Boolean(blueprint.apiOnly) }).toEqual({
        name,
        apiOnly: await isConfirmedApiOnlyApp(destination),
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps the alternatives the add auth and add resource refusals name', async () => {
    // The refusal is the one place make-auth.ts names the middleware.
    expect(await readCliSource('make-auth.ts')).toContain('createBearerTokenMiddleware')

    const match = (await readCliSource('make-feature.ts')).match(
      /export const API_ONLY_FEATURE_ALTERNATIVE = '([^']+)'/u,
    )
    expect(match).not.toBeNull()
    expect(match![1]).toContain('make:controller')
    expect(match![1]).toContain('routes/api.ts')
  })
})
