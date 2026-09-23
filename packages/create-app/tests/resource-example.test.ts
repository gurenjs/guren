import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileExists } from '../../cli/src/discovery'
import { parseFieldsString } from '../../cli/src/fields'
import { collectionSlug, schemaIdentifierFor, singularize } from '../../cli/src/inflect'
import { DEFAULT_ROUTES_FILE } from '../../cli/src/route-registrar'
import { schemaDeclaresTable } from '../../cli/src/schema-parser'
import { pascalCase } from '../../cli/src/utils'
import { DEFAULT_RESOURCE_EXAMPLE, getAppBlueprint, listAppBlueprints, scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace, type TempWorkspace } from './helpers'

/**
 * Names are derived as @guren/cli's addResource() derives them. The targets are
 * the files makeFeature refuses to overwrite; the table and routes are ones
 * addResource() skips when present. The blog's own Post is the control that
 * the same derivation finds every target in a real layout.
 */
const PAGE_BLUEPRINTS = listAppBlueprints().filter((name) => !getAppBlueprint(name).apiOnly)

function resourceNames(name: string): { singular: string; slug: string; identifier: string } {
  const singular = singularize(pascalCase(name))
  return { singular, slug: collectionSlug(singular), identifier: schemaIdentifierFor(singular) }
}

function featureTargets(singular: string, slug: string): string[] {
  return [
    `app/Http/Validators/${singular}Validator.ts`,
    `app/Http/Resources/${singular}Resource.ts`,
    `app/Http/Controllers/${singular}Controller.ts`,
    `resources/js/pages/${slug}/`,
    `app/Models/${singular}.ts`,
  ]
}

async function presentTargets(app: string, singular: string, slug: string): Promise<string[]> {
  const present: string[] = []
  for (const target of featureTargets(singular, slug)) {
    if (await fileExists(app, target)) {
      present.push(target)
    }
  }
  return present
}

function useScaffold(name: string): () => string {
  let workspace: TempWorkspace | undefined
  let app = ''

  beforeAll(async () => {
    workspace = await createTempWorkspace(`guren-resource-example-${name}-`)
    app = join(workspace.dir, 'app')
    await scaffoldAppBlueprint({ blueprint: name, destination: app, renderingMode: 'spa', database: 'sqlite' })
  })

  afterAll(async () => {
    await workspace?.cleanup()
  })

  return () => app
}

describe('blog template control', () => {
  const app = useScaffold('blog')
  const { singular, slug, identifier } = resourceNames('posts')

  it('finds every add resource target of the Post it ships', async () => {
    expect(await presentTargets(app(), singular, slug)).toEqual(featureTargets(singular, slug))
    expect(await schemaDeclaresTable(app(), identifier)).toBe(true)
    expect(await readFile(join(app(), DEFAULT_ROUTES_FILE), 'utf8')).toContain(`'/${slug}'`)
  })
})

describe.each(PAGE_BLUEPRINTS)('%s blueprint add resource example', (name) => {
  const example = getAppBlueprint(name).resourceExample ?? DEFAULT_RESOURCE_EXAMPLE
  const { singular, slug, identifier } = resourceNames(example.name)
  const app = useScaffold(name)

  it('names a resource whose files add resource can create', async () => {
    expect(await presentTargets(app(), singular, slug)).toEqual([])
  })

  it('names a resource the template does not already ship', async () => {
    expect(await schemaDeclaresTable(app(), identifier)).toBe(false)

    const routes = await readFile(join(app(), DEFAULT_ROUTES_FILE), 'utf8')
    expect(routes).not.toContain(`'${slug}.index'`)
    expect(routes).not.toContain(`'/${slug}'`)
  })

  it('passes fields add resource accepts', () => {
    expect(() => parseFieldsString(example.fields)).not.toThrow()
  })
})
