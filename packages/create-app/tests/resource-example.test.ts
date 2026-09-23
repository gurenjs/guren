import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_RESOURCE_EXAMPLE, getAppBlueprint, listAppBlueprints, scaffoldAppBlueprint } from '../src/blueprints'
import { directoryExists } from '../src/utils'
import { createTempWorkspace } from './helpers'

/**
 * The next steps suggest `guren add resource <example>`, which refuses a file
 * that already exists; its --force hint would overwrite the template's own.
 * Every example is plural, so its first token is the pages directory and the
 * schema export add resource writes, with no inflection.
 */
const PAGE_BLUEPRINTS = listAppBlueprints().filter((name) => !getAppBlueprint(name).apiOnly)

describe('add resource example', () => {
  it.each(PAGE_BLUEPRINTS)('names a resource the %s blueprint does not ship', async (name) => {
    const example = getAppBlueprint(name).resourceExample ?? DEFAULT_RESOURCE_EXAMPLE
    const resource = example.split(' ')[0]!
    const workspace = await createTempWorkspace(`guren-resource-example-${name}-`)
    try {
      const destination = join(workspace.dir, 'app')
      await scaffoldAppBlueprint({ blueprint: name, destination, renderingMode: 'spa', database: 'sqlite' })

      expect(await directoryExists(join(destination, 'resources/js/pages', resource))).toBe(false)
      const schema = await readFile(join(destination, 'db/schema.ts'), 'utf8')
      expect(schema).not.toMatch(new RegExp(`export const ${resource}\\s*=`, 'u'))
    } finally {
      await workspace.cleanup()
    }
  })
})
