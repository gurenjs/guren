import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileExists, MODELS_DIR } from '../../cli/src/discovery'
import { parseFieldsString } from '../../cli/src/fields'
import { collectionSlug, schemaIdentifierFor, singularize } from '../../cli/src/inflect'
import { DEFAULT_ROUTES_FILE, findRouteRegistrar } from '../../cli/src/route-registrar'
import { schemaDeclaresTable } from '../../cli/src/schema-parser'
import { pascalCase } from '../../cli/src/utils'
import { DEFAULT_RESOURCE_EXAMPLE, getAppBlueprint, listAppBlueprints, scaffoldAppBlueprint } from '../src/blueprints'
import { createTempWorkspace, type TempWorkspace } from './helpers'

/**
 * Names are derived as @guren/cli's addResource() derives them and read with the
 * CLI's own readers. The blog blueprint doubles as the control: the same
 * derivation must find everything its own Post ships.
 */
const PAGE_BLUEPRINTS = listAppBlueprints().filter((name) => !getAppBlueprint(name).apiOnly)

const EXAMPLES = [...new Set(PAGE_BLUEPRINTS.map((name) => getAppBlueprint(name).resourceExample ?? DEFAULT_RESOURCE_EXAMPLE))]

function resourceNames(name: string): { singular: string; slug: string; identifier: string } {
  const singular = singularize(pascalCase(name))
  return { singular, slug: collectionSlug(singular), identifier: schemaIdentifierFor(singular) }
}

/** The paths makeFeature writes. The table and routes are ones addResource() skips when present. */
function featureTargets(singular: string, slug: string): string[] {
  return [
    `app/Http/Validators/${singular}Validator.ts`,
    `app/Http/Resources/${singular}Resource.ts`,
    `app/Http/Controllers/${singular}Controller.ts`,
    `resources/js/pages/${slug}/`,
    `${MODELS_DIR}/${singular}.ts`,
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

it('keeps the blog blueprint, whose Post is the control', () => {
  expect(PAGE_BLUEPRINTS).toContain('blog')
})

it.each(EXAMPLES.map((example) => [example.name, example.fields] as const))('passes %s fields add resource accepts', (_name, fields) => {
  expect(() => parseFieldsString(fields)).not.toThrow()
})

describe.each(PAGE_BLUEPRINTS)('%s blueprint add resource example', (name) => {
  const example = getAppBlueprint(name).resourceExample ?? DEFAULT_RESOURCE_EXAMPLE
  const { singular, slug, identifier } = resourceNames(example.name)
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

  it('names a resource whose paths add resource can write', async () => {
    expect(await presentTargets(app, singular, slug)).toEqual([])
  })

  it('names a resource the template does not already ship', async () => {
    expect(await fileExists(app, 'db/schema.ts')).toBe(true)
    expect(await schemaDeclaresTable(app, identifier)).toBe(false)

    const routes = await readFile(join(app, DEFAULT_ROUTES_FILE), 'utf8')
    expect(findRouteRegistrar(routes)).not.toBeNull()
    expect(routes).not.toContain(`'${slug}.index'`)
    expect(routes).not.toContain(`'/${slug}'`)
  })

  it.if(name === 'blog')('finds every add resource target of the Post it ships', async () => {
    const post = resourceNames('posts')
    expect(await presentTargets(app, post.singular, post.slug)).toEqual(featureTargets(post.singular, post.slug))
    expect(await schemaDeclaresTable(app, post.identifier)).toBe(true)

    const routes = await readFile(join(app, DEFAULT_ROUTES_FILE), 'utf8')
    expect(routes).toContain(`'${post.slug}.index'`)
    expect(routes).toContain(`'/${post.slug}'`)
  })
})
