import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
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

  // Mutating tests below restore green here, so order stays irrelevant
  afterEach(async () => {
    const { directoryExists } = await import('../src/discovery')
    if (await directoryExists(join(workspace.dir, 'docs/spec'))) {
      await writeSpecArtifacts({ cwd: workspace.dir })
    }
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
  })

  it('fails when a committed view is missing', async () => {
    await rm(join(workspace.dir, 'docs/spec/er.md'))

    const results = await runSpecCheck({ cwd: workspace.dir })
    const er = results.find((r) => r.key === 'spec-drift:er.md')

    expect(er?.status).toBe('fail')
    expect(er?.message).toContain('missing')
  })

  it('skips regeneration under --changed when nothing spec-relevant changed', async () => {
    const results = await runSpecCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['README.md']),
    })

    expect(results).toEqual([])
  })

  it('regenerates only the views whose sources changed', async () => {
    const results = await runSpecCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['db/schema.ts']),
    })

    const keys = results.map((r) => r.key)
    // db/schema.ts feeds er.md (and modules.md via the any-source rule),
    // but not the screens view
    expect(keys).toContain('spec-drift:er.md')
    expect(keys).not.toContain('spec-drift:screens.md')
  })

  it('regenerates the screens view when a module routes-directory file changed', async () => {
    // Where `make:route --module billing` writes: the file is reached
    // transitively through the module registrar, so it can change screens.md
    // without touching modules/billing/routes.ts itself.
    const results = await runSpecCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['modules/billing/routes/invoice.ts']),
    })

    expect(results.map((r) => r.key)).toContain('spec-drift:screens.md')
  })

  it('regenerates the screens view for a module file outside the scaffold conventions', async () => {
    // A registrar may import a prefix constant or helper from anywhere in
    // its module — the source set is the import closure of index.ts, not a
    // list of conventional file names.
    const results = await runSpecCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['modules/billing/route-config.ts']),
    })

    expect(results.map((r) => r.key)).toContain('spec-drift:screens.md')
  })

  it('re-verifies a view when its committed file itself changed', async () => {
    const results = await runSpecCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['docs/spec/screens.md']),
    })

    expect(results.map((r) => r.key)).toEqual(['spec-drift:screens.md'])
  })

  it('degrades the screens view when the routes path cannot even be probed', async () => {
    // Its own workspace: this one is deliberately broken, and the shared
    // fixture above is restored between tests rather than rebuilt.
    //
    // The drift gate reads a routes file it cannot load as `degraded` and
    // skips the byte comparison — diffing hollow content would report drift
    // that regenerating could only "fix" by destroying the committed view.
    // That only holds if the existence probe reaches the loader: a `routes`
    // that is a regular file makes the probe throw ENOTDIR, which used to
    // escape `runSpecCheck` as a stack trace instead of this warning.
    const broken = await createTempWorkspace('guren-cli-spec-check-notdir-')

    try {
      await writeFile(join(broken.dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(broken.dir, 'routes'), 'not a directory', 'utf8')
      await mkdir(join(broken.dir, 'docs/spec'), { recursive: true })
      await writeFile(join(broken.dir, 'docs/spec/screens.md'), '# stale\n', 'utf8')

      const results = await runSpecCheck({ cwd: broken.dir })
      const screens = results.find((r) => r.key === 'spec-drift:screens.md')

      expect(screens?.status).toBe('warn')
      expect(screens?.message).toContain('route graph failed to load')
    } finally {
      await broken.cleanup()
    }
  })
})
