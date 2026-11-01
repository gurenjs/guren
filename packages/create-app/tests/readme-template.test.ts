import { describe, expect, it } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DATABASE_DRIVERS,
  listAppBlueprints,
  renderReadmeBlocks,
  scaffoldAppBlueprint,
  templateDir,
  type AppBlueprintName,
  type DatabaseDriver,
  type RenderingMode,
} from '../src/blueprints'
import { createTempWorkspace } from './helpers'

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

describe('scaffolded README', () => {
  // A README in an overlay replaces the base one wholesale, which is how the SSR
  // README kept describing PostgreSQL after the default moved to SQLite.
  it('ships from the base template only, not from the SSR overlay', async () => {
    await expect(access(join(templateDir('default-ssr'), 'README.md'))).rejects.toThrow()
  })

  it('describes the SQLite app it was created with, in both modes', async () => {
    for (const mode of ['spa', 'ssr'] as const) {
      const readme = await scaffoldReadme('default', mode, 'sqlite')
      expect(readme).toContain('No Docker')
      expect(readme).toContain('bun run db:migrate')
      expect(readme).toContain('This app uses SQLite.')
      expect(readme).not.toContain('db:up')
      expect(readme).not.toContain('PostgreSQL runs')
    }
  })

  it('starts the container before migrating for PostgreSQL and MySQL', async () => {
    for (const [database, label] of [['postgres', 'PostgreSQL'], ['mysql', 'MySQL']] as const) {
      const readme = await scaffoldReadme('default', 'spa', database)
      expect(readme).not.toContain('No Docker')
      expect(readme).toContain(`This app uses ${label}.`)
      expect(readme).toContain(`bun run db:up        # start the ${label} container`)
      expect(readme.indexOf('bun run db:up')).toBeLessThan(readme.indexOf('bun run db:migrate'))
    }
  })

  it('carries the SSR section only in SSR mode', async () => {
    expect(await scaffoldReadme('default', 'ssr', 'sqlite')).toContain('## Server-Side Rendering')
    expect(await scaffoldReadme('default', 'spa', 'sqlite')).not.toContain('## Server-Side Rendering')
  })

  it('leaves no marker or token behind in any blueprint, mode or driver', async () => {
    // `worker` copies the same layers as `default`, and its postScaffold
    // chdirs into the app, which is global state across this test process.
    for (const blueprint of listAppBlueprints().filter((name) => name !== 'worker')) {
      for (const mode of ['spa', 'ssr'] as const) {
        for (const database of DATABASE_DRIVERS) {
          const readme = await scaffoldReadme(blueprint, mode, database)
          expect(readme).not.toMatch(/guren:[a-z-]+ -->/u)
          expect(readme).not.toMatch(/__[A-Z_]+__/u)
        }
      }
    }
  }, 60_000)
})

describe('renderReadmeBlocks', () => {
  const blocks = { ssr: true, container: false, 'no-container': true }

  it('keeps the lines of an enabled block and drops a disabled one', () => {
    const content = 'a\n<!-- guren:ssr -->\nb\n<!-- /guren:ssr -->\n<!-- guren:container -->\nc\n<!-- /guren:container -->\nd'
    expect(renderReadmeBlocks(content, blocks)).toBe('a\nb\nd')
  })

  it('throws on an unknown, nested or unclosed marker', () => {
    expect(() => renderReadmeBlocks('<!-- guren:spa -->\n<!-- /guren:spa -->', blocks)).toThrow('names no known block')
    expect(() => renderReadmeBlocks('<!-- guren:ssr -->\n<!-- guren:container -->', blocks)).toThrow('does not match')
    expect(() => renderReadmeBlocks('<!-- guren:ssr -->\nb', blocks)).toThrow('never closed')
  })
})
