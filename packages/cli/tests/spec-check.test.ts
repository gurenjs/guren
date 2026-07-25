import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { runSpecCheck } from '../src/spec-check'
import { writeSpecArtifacts } from '../src/spec-generate'
import { createTempWorkspace, type TempWorkspace } from './helpers'

const SCHEMA = `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`

describe('runSpecCheck', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-check-')
    const dir = workspace.dir

    await mkdir(join(dir, 'db'), { recursive: true })
    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    await writeFile(join(dir, 'db/schema.ts'), SCHEMA, 'utf8')
    await writeFile(
      join(dir, 'app/Models/Post.ts'),
      `import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {}
`,
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('returns nothing when docs/spec does not exist', async () => {
    expect(await runSpecCheck({ cwd: workspace.dir })).toEqual([])
  })

  it('passes when committed views match a fresh regeneration', async () => {
    await writeSpecArtifacts({ cwd: workspace.dir })

    const results = await runSpecCheck({ cwd: workspace.dir })

    expect(results).toHaveLength(4)
    expect(results.every((r) => r.status === 'pass')).toBe(true)
    expect(results.map((r) => r.key).sort()).toEqual([
      'spec-drift:domain.md',
      'spec-drift:er.md',
      'spec-drift:modules.md',
      'spec-drift:screens.md',
    ])
  })

  it('fails when the schema changes without regenerating', async () => {
    await writeFile(
      join(workspace.dir, 'db/schema.ts'),
      SCHEMA.replace("title: text('title').notNull(),", "title: text('title').notNull(),\n  excerpt: text('excerpt'),"),
      'utf8',
    )

    const results = await runSpecCheck({ cwd: workspace.dir })
    const er = results.find((r) => r.key === 'spec-drift:er.md')

    expect(er?.status).toBe('fail')
    expect(er?.suggestion).toContain('spec:generate')

    // Regenerate to restore green for the following tests
    await writeSpecArtifacts({ cwd: workspace.dir })
  })

  it('fails when a committed view is missing', async () => {
    await rm(join(workspace.dir, 'docs/spec/er.md'))

    const results = await runSpecCheck({ cwd: workspace.dir })
    const er = results.find((r) => r.key === 'spec-drift:er.md')

    expect(er?.status).toBe('fail')
    expect(er?.message).toContain('missing')

    await writeSpecArtifacts({ cwd: workspace.dir })
  })

  it('skips regeneration under --changed when nothing spec-relevant changed', async () => {
    const results = await runSpecCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['README.md']),
    })

    expect(results).toEqual([])
  })

  it('runs under --changed when a spec source changed', async () => {
    const results = await runSpecCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['db/schema.ts']),
    })

    expect(results.length).toBeGreaterThan(0)
  })
})
