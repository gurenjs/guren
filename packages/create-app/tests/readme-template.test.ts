import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DATABASE_DRIVERS,
  getAppBlueprint,
  listAppBlueprints,
  listBlueprintTemplates,
  renderReadmeBlocks,
  scaffoldAppBlueprint,
  templateDir,
  usesDatabaseContainer,
  type AppBlueprintName,
  type DatabaseDriver,
  type RenderingMode,
} from '../src/blueprints'
import { createTempWorkspace } from './helpers'

const MARKER_LIKE = /<!--\s*\/?guren:/u

async function scaffoldReadme(blueprint: AppBlueprintName, renderingMode: RenderingMode, database: DatabaseDriver): Promise<string> {
  const workspace = await createTempWorkspace('guren-create-app-readme-')
  try {
    const destination = join(workspace.dir, 'readme-app')
    await scaffoldAppBlueprint({ blueprint, destination, renderingMode, database })
    return await readFile(join(destination, 'README.md'), 'utf8')
  } finally {
    await workspace.cleanup()
  }
}

async function readTemplateReadme(layer: Parameters<typeof templateDir>[0]): Promise<string | null> {
  return readFile(join(templateDir(layer), 'README.md'), 'utf8').catch(() => null)
}

function blockContents(readme: string): string[] {
  return [...readme.matchAll(/^<!-- guren:([a-z-]+) -->\n([\s\S]*?)^<!-- \/guren:\1 -->$/gmu)]
    .map(([, name, body]) => `${name}\n${body}`)
}

// `worker` copies the same layers as `default`, and its postScaffold chdirs into
// the app, which is global state across this test process.
const BLUEPRINTS = listAppBlueprints().filter((name) => name !== 'worker')

describe('scaffolded README', () => {
  it('describes the mode and driver the app was created with, in every blueprint', async () => {
    for (const blueprint of BLUEPRINTS) {
      const { apiOnly } = getAppBlueprint(blueprint)
      for (const mode of ['spa', 'ssr'] as const) {
        for (const database of DATABASE_DRIVERS) {
          const readme = await scaffoldReadme(blueprint, mode, database)
          const label = `${blueprint}/${mode}/${database}`

          expect({ label, residue: MARKER_LIKE.test(readme) || /__[A-Z_]+__/u.test(readme) }).toEqual({ label, residue: false })
          expect({ label, dbUp: readme.includes('bun run db:up') }).toEqual({ label, dbUp: usesDatabaseContainer(database) })
          expect({ label, noDocker: readme.includes('No Docker') }).toEqual({ label, noDocker: !usesDatabaseContainer(database) })
          if (usesDatabaseContainer(database)) {
            expect(readme.indexOf('bun run db:up')).toBeLessThan(readme.indexOf('bun run db:migrate'))
          }
          const ssr = mode === 'ssr' && !apiOnly
          expect({ label, ssr: readme.includes('## Server-Side Rendering') }).toEqual({ label, ssr })
        }
      }
    }
  }, 60_000)

  it('names the driver in the default README', async () => {
    expect(await scaffoldReadme('default', 'spa', 'sqlite')).toContain('This app uses SQLite.')
    expect(await scaffoldReadme('default', 'spa', 'mysql')).toContain('This app uses MySQL.')
  })

  // A README in a later layer replaces the earlier one wholesale, so each one
  // that lands must carry the blocks itself.
  it('carries only blocks the default README carries verbatim', async () => {
    const reference = new Set(blockContents((await readTemplateReadme('default'))!))
    const layers = new Set(listAppBlueprints().flatMap((name) => listBlueprintTemplates(getAppBlueprint(name))))

    for (const layer of layers) {
      const readme = await readTemplateReadme(layer)
      if (readme === null) {
        continue
      }
      for (const block of blockContents(readme)) {
        expect({ layer, block, shared: reference.has(block) }).toEqual({ layer, block, shared: true })
      }
    }
  })
})

describe('renderReadmeBlocks', () => {
  const blocks = { ssr: true, container: false, 'no-container': true }

  it('keeps the lines of an enabled block and drops a disabled one', () => {
    const content = 'a\n<!-- guren:ssr -->\nb\n<!-- /guren:ssr -->\n<!-- guren:container -->\nc\n<!-- /guren:container -->\nd'
    expect(renderReadmeBlocks(content, blocks)).toBe('a\nb\nd')
  })

  it('throws on a malformed, unknown, nested or unclosed marker', () => {
    expect(() => renderReadmeBlocks('<!--guren:ssr-->\nb\n<!-- /guren:ssr -->', blocks)).toThrow('looks like a block marker')
    expect(() => renderReadmeBlocks('  <!-- guren:ssr -->', blocks)).toThrow('looks like a block marker')
    expect(() => renderReadmeBlocks('<!-- guren:spa -->\n<!-- /guren:spa -->', blocks)).toThrow('names no known block')
    expect(() => renderReadmeBlocks('<!-- guren:ssr -->\n<!-- guren:container -->', blocks)).toThrow('does not match')
    expect(() => renderReadmeBlocks('<!-- guren:ssr -->\nb', blocks)).toThrow('never closed')
  })
})
