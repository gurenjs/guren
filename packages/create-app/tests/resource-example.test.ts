import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectionSlug, schemaIdentifierFor, singularize } from '../../cli/src/inflect'
import { pascalCase } from '../../cli/src/utils'
import { DEFAULT_RESOURCE_EXAMPLE, getAppBlueprint, listAppBlueprints, scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace, type TempWorkspace } from './helpers'

/**
 * Names are derived as @guren/cli's addResource() derives them. The refused
 * targets are makeFeature()'s `wx` writes; the schema export and the route are
 * ones addResource() skips instead, checked so the example adds something new.
 */
const PAGE_BLUEPRINTS = listAppBlueprints().filter((name) => !getAppBlueprint(name).apiOnly)

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

describe.each(PAGE_BLUEPRINTS)('%s blueprint add resource example', (name) => {
  const example = getAppBlueprint(name).resourceExample ?? DEFAULT_RESOURCE_EXAMPLE
  const singular = singularize(pascalCase(example.name))
  const slug = collectionSlug(singular)
  let workspace: TempWorkspace
  let app: string

  beforeAll(async () => {
    workspace = await createTempWorkspace(`guren-resource-example-${name}-`)
    app = join(workspace.dir, 'app')
    await scaffoldAppBlueprint({ blueprint: name, destination: app, renderingMode: 'spa', database: 'sqlite' })
  })

  afterAll(async () => {
    await workspace?.cleanup()
  })

  it('names a resource none of whose files add resource refuses to overwrite', async () => {
    const targets = [
      `app/Http/Validators/${singular}Validator.ts`,
      `app/Http/Resources/${singular}Resource.ts`,
      `app/Http/Controllers/${singular}Controller.ts`,
      `resources/js/pages/${slug}/`,
      `app/Models/${singular}.ts`,
    ]
    const present: string[] = []
    for (const target of targets) {
      if (await exists(join(app, target))) {
        present.push(target)
      }
    }

    expect(present).toEqual([])
  })

  it('names a resource the template does not already ship', async () => {
    const schema = await readFile(join(app, 'db/schema.ts'), 'utf8')
    expect(schema).not.toMatch(new RegExp(`export const ${schemaIdentifierFor(singular)}\\b`, 'u'))

    const routes = await readFile(join(app, 'routes/web.ts'), 'utf8')
    expect(routes).not.toContain(`'/${slug}'`)
  })
})
