import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { runDocsCheck } from '../src/docs-check'
import { runCheck } from '../src/check'
import { createTempWorkspace, type TempWorkspace } from './helpers'

describe('runDocsCheck', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-docs-check-')
    const dir = workspace.dir

    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
    await mkdir(join(dir, 'docs/adr'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')

    await writeFile(
      join(dir, 'app/Models/Post.ts'),
      `/**
 * @docs docs/adr/0001-valid.md
 */
export class Post {}
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'app/Models/Legacy.ts'),
      `/** @docs docs/adr/missing-target.md */
export class Legacy {}
`,
      'utf8',
    )

    // Valid doc: resolvable related paths + real entity
    await writeFile(
      join(dir, 'docs/adr/0001-valid.md'),
      `---
kind: adr
status: accepted
entities: [Post]
related:
  - app/Models/Post.ts
  - app/Models/*.ts
---

# Valid decision
`,
      'utf8',
    )

    // Broken doc: dangling related path + unknown entity
    await writeFile(
      join(dir, 'docs/adr/0002-broken.md'),
      `---
kind: adr
status: draft
entities: [Ghost]
related: [app/Services/Deleted.ts]
---

# Broken decision
`,
      'utf8',
    )

    // Superseded-only entity link
    await writeFile(
      join(dir, 'docs/adr/0003-superseded.md'),
      `---
kind: adr
status: superseded
entities: [Legacy]
last_reviewed: 2020-01-01
---

# Old decision
`,
      'utf8',
    )

    // No frontmatter: never validated
    await writeFile(join(dir, 'docs/notes.md'), '# Free-form notes\n', 'utf8')
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('passes docs whose related paths, globs, and entities all resolve', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const pass = results.find((r) => r.key === 'docs-links:docs/adr/0001-valid.md')
    expect(pass?.status).toBe('pass')
  })

  it('fails dangling related paths and unknown entities', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const related = results.find(
      (r) => r.key === 'docs-related:docs/adr/0002-broken.md:app/Services/Deleted.ts',
    )
    expect(related?.status).toBe('fail')

    const entity = results.find((r) => r.key === 'docs-entity:docs/adr/0002-broken.md:Ghost')
    expect(entity?.status).toBe('fail')
  })

  it('warns when every doc linked to an entity is superseded', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const superseded = results.find((r) => r.key === 'docs-superseded:Legacy')
    expect(superseded?.status).toBe('warn')
    expect(superseded?.message).toContain('docs/adr/0003-superseded.md')
  })

  it('does not flag entities that also have a current doc', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    expect(results.find((r) => r.key === 'docs-superseded:Post')).toBeUndefined()
  })

  it('validates @docs tags in model sources', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const valid = results.find(
      (r) => r.key === 'docs-tag:app/Models/Post.ts:docs/adr/0001-valid.md',
    )
    expect(valid?.status).toBe('pass')

    const broken = results.find(
      (r) => r.key === 'docs-tag:app/Models/Legacy.ts:docs/adr/missing-target.md',
    )
    expect(broken?.status).toBe('fail')
  })

  it('warns on stale last_reviewed only when a TTL is configured', async () => {
    const without = await runDocsCheck({ cwd: workspace.dir })
    expect(without.find((r) => r.key === 'docs-stale:docs/adr/0003-superseded.md')).toBeUndefined()

    const withTtl = await runDocsCheck({ cwd: workspace.dir, ttlDays: 180 })
    const stale = withTtl.find((r) => r.key === 'docs-stale:docs/adr/0003-superseded.md')
    expect(stale?.status).toBe('warn')
  })

  it('never validates docs without frontmatter', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    expect(results.some((r) => r.key.includes('docs/notes.md'))).toBe(false)
  })

  it('restricts validation to the changed scope', async () => {
    const results = await runDocsCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['docs/adr/0002-broken.md']),
    })

    expect(results.some((r) => r.key.startsWith('docs-related:docs/adr/0002-broken.md'))).toBe(true)
    expect(results.some((r) => r.key === 'docs-links:docs/adr/0001-valid.md')).toBe(false)
    // Tag validation follows changed source files, none of which changed here
    expect(results.some((r) => r.key.startsWith('docs-tag:'))).toBe(false)
  })

  it('pulls docs into --changed scope when their model was deleted', async () => {
    // app/Models/Ghost.ts never existed on disk, mirroring a deletion whose
    // path is still present in the changed-files set.
    const results = await runDocsCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['app/Models/Ghost.ts']),
    })

    const entity = results.find((r) => r.key === 'docs-entity:docs/adr/0002-broken.md:Ghost')
    expect(entity?.status).toBe('fail')
  })

  it('matches globs against non-source files', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-glob-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await mkdir(join(scoped.dir, 'db/migrations'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(scoped.dir, 'db/migrations/0001_init.sql'), 'select 1;', 'utf8')
      await writeFile(
        join(scoped.dir, 'docs/migrations.md'),
        `---
related: [db/migrations/*.sql]
---
# Migrations
`,
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })
      expect(results.find((r) => r.key === 'docs-links:docs/migrations.md')?.status).toBe('pass')
    } finally {
      await scoped.cleanup()
    }
  })

  it('rejects related entries and @docs tags that escape the app root', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-escape-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await mkdir(join(scoped.dir, 'app/Models'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'app/Models/Post.ts'),
        '/** @docs ../outside.md */\nexport class Post {}\n',
        'utf8',
      )
      await writeFile(
        join(scoped.dir, 'docs/escape.md'),
        `---
related: [../outside.md]
---
# Escape
`,
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })
      expect(
        results.find((r) => r.key === 'docs-related:docs/escape.md:../outside.md')?.status,
      ).toBe('fail')
      expect(
        results.find((r) => r.key === 'docs-tag:app/Models/Post.ts:../outside.md')?.status,
      ).toBe('fail')
    } finally {
      await scoped.cleanup()
    }
  })

  it('runs the union when --arch and --docs are combined', async () => {
    const report = await runCheck({ cwd: workspace.dir, arch: true, docs: true })

    // Docs suite ran (broken doc fails), arch suite ran, core suite did not
    expect(report.checks.some((c) => c.key.startsWith('docs-related:'))).toBe(true)
    expect(report.checks.some((c) => c.key.startsWith('manifest:'))).toBe(false)
    expect(report.failCount).toBeGreaterThan(0)
  })

  it('produces zero results for apps without docs or tags', async () => {
    const empty = await createTempWorkspace('guren-cli-docs-none-')
    try {
      await mkdir(join(empty.dir, 'app/Models'), { recursive: true })
      await writeFile(join(empty.dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
      await writeFile(join(empty.dir, 'package.json'), '{}', 'utf8')

      expect(await runDocsCheck({ cwd: empty.dir })).toEqual([])
    } finally {
      await empty.cleanup()
    }
  })
})
