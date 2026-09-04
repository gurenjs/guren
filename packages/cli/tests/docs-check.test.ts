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

    await writeFile(
      join(dir, 'docs/adr/0001-valid.md'),
      `---
type: adr
status: stable
entities: [Post]
related:
  - app/Models/Post.ts
  - app/Models/*.ts
---

# Valid decision

Superseded by [the broken one](/adr/0002-broken.md); implemented in
[the model](../../app/Models/Post.ts).
`,
      'utf8',
    )

    await writeFile(
      join(dir, 'docs/adr/0002-broken.md'),
      `---
type: adr
status: draft
entities: [Ghost]
related: [app/Services/Deleted.ts]
---

# Broken decision

See [missing](./nope.md) and [outside](../../../outside.md).
`,
      'utf8',
    )

    await writeFile(
      join(dir, 'docs/adr/0003-deprecated.md'),
      `---
type: adr
status: deprecated
entities: [Legacy]
stale_after: 2020-01-01
---

# Old decision
`,
      'utf8',
    )

    await writeFile(
      join(dir, 'docs/adr/0004-untyped.md'),
      `---
entities: [Post]
---

# Untyped decision
`,
      'utf8',
    )

    await writeFile(join(dir, 'docs/notes.md'), '# Free-form notes\n', 'utf8')
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('passes docs whose related paths, entities, and body links all resolve', async () => {
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

  it('fails frontmatter without a type — the one field OKF requires', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const untyped = results.find((r) => r.key === 'docs-type:docs/adr/0004-untyped.md')
    expect(untyped?.status).toBe('fail')
    expect(results.find((r) => r.key === 'docs-type:docs/adr/0001-valid.md')).toBeUndefined()
  })

  it('warns on a dangling body link and fails one escaping the app root', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const missing = results.find((r) => r.key === 'docs-link:docs/adr/0002-broken.md:./nope.md')
    expect(missing?.status).toBe('warn')

    const escaping = results.find(
      (r) => r.key === 'docs-link:docs/adr/0002-broken.md:../../../outside.md',
    )
    expect(escaping?.status).toBe('fail')
  })

  it('warns when every doc linked to an entity is deprecated', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const deprecated = results.find((r) => r.key === 'docs-deprecated:Legacy')
    expect(deprecated?.status).toBe('warn')
    expect(deprecated?.message).toContain('docs/adr/0003-deprecated.md')
  })

  it('does not flag entities that also have a current doc', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    expect(results.find((r) => r.key === 'docs-deprecated:Post')).toBeUndefined()
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

  it('warns on actors outside the OKF convention and unparseable timestamps', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-actors-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'docs/provenance.md'),
        `---
type: context
generated: { by: not-an-actor, at: nonsense }
verified:
  - { by: ada, at: 2026-07-25T09:00:00Z }
  - { by: human:\u5c71\u7530\u592a\u90ce, at: 2026-07-26T09:00:00Z }
  - { at: 2026-07-27T09:00:00Z }
---
# Provenance
`,
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })
      const key = (suffix: string) => `docs-actor:docs/provenance.md:${suffix}`

      // A bare name silently reads as machine-confirmed, which is why it warns.
      expect(results.find((r) => r.key === key('generated.by'))?.status).toBe('warn')
      expect(results.find((r) => r.key === key('generated.at'))?.status).toBe('warn')
      expect(results.find((r) => r.key === key('verified[0].by'))?.status).toBe('warn')
      expect(results.find((r) => r.key === key('verified[2].by'))?.status).toBe('warn')
      expect(results.find((r) => r.key === key('verified[1].by'))).toBeUndefined()
    } finally {
      await scoped.cleanup()
    }
  })

  it('accepts every OKF actor form without warning', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-actors-ok-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'docs/ok.md'),
        `---
type: context
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }
verified:
  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }
  - { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }
---
# All forms
`,
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })

      expect(results.some((r) => r.key.startsWith('docs-actor:'))).toBe(false)
    } finally {
      await scoped.cleanup()
    }
  })

  it('warns when a doc declares itself stale via stale_after', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const stale = results.find((r) => r.key === 'docs-stale:docs/adr/0003-deprecated.md')
    expect(stale?.status).toBe('warn')
    expect(results.find((r) => r.key === 'docs-stale:docs/adr/0001-valid.md')).toBeUndefined()
  })

  it('warns on docs without frontmatter once the convention is adopted', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })

    const conformance = results.find((r) => r.key === 'docs-frontmatter:docs/notes.md')
    expect(conformance?.status).toBe('warn')
    expect(
      results.some((r) => r.key.includes('docs/notes.md') && r.key !== 'docs-frontmatter:docs/notes.md'),
    ).toBe(false)
  })

  it('restricts validation to the changed scope', async () => {
    const results = await runDocsCheck({
      cwd: workspace.dir,
      changedFiles: new Set(['docs/adr/0002-broken.md']),
    })

    expect(results.some((r) => r.key.startsWith('docs-related:docs/adr/0002-broken.md'))).toBe(true)
    // 0001-valid.md links /adr/0002-broken.md in its body, so the change
    // pulls it into scope too; 0003-deprecated.md references nothing changed.
    expect(results.some((r) => r.key === 'docs-links:docs/adr/0001-valid.md')).toBe(true)
    expect(results.some((r) => r.key.includes('docs/adr/0003-deprecated.md'))).toBe(false)
    expect(results.some((r) => r.key === 'docs-frontmatter:docs/notes.md')).toBe(false)
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

  it('pulls docs into --changed scope when a body-link target changed', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-link-scope-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await mkdir(join(scoped.dir, 'config'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(scoped.dir, 'config/billing.ts'), 'export const cycle = 30\n', 'utf8')
      await writeFile(
        join(scoped.dir, 'docs/billing.md'),
        `---
type: context
---
# Billing

Configured in [billing config](../config/billing.ts).
`,
        'utf8',
      )

      const results = await runDocsCheck({
        cwd: scoped.dir,
        changedFiles: new Set(['config/billing.ts']),
      })

      expect(results.some((r) => r.key === 'docs-links:docs/billing.md')).toBe(true)
    } finally {
      await scoped.cleanup()
    }
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
type: context
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
type: context
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

  it('resolves bundle-relative links inside a module docs bundle', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-module-links-')
    try {
      await mkdir(join(scoped.dir, 'modules/billing/docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'modules/billing/docs/overview.md'),
        `---
type: context
---
# Overview

See [invoicing](/invoicing.md).
`,
        'utf8',
      )
      await writeFile(
        join(scoped.dir, 'modules/billing/docs/invoicing.md'),
        '---\ntype: context\n---\n# Invoicing\n',
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })
      expect(
        results.find((r) => r.key === 'docs-links:modules/billing/docs/overview.md')?.status,
      ).toBe('pass')
    } finally {
      await scoped.cleanup()
    }
  })

  it('resolves bundle-relative links in a module whose name ends in docs', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-apidocs-')
    try {
      await mkdir(join(scoped.dir, 'modules/apidocs/docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'modules/apidocs/docs/overview.md'),
        '---\ntype: context\n---\n# Overview\n\nSee [target](/target.md).\n',
        'utf8',
      )
      await writeFile(
        join(scoped.dir, 'modules/apidocs/docs/target.md'),
        '---\ntype: context\n---\n# Target\n',
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })

      // 'docs/' also occurs inside 'apidocs/', so a substring-based bundle
      // root would resolve this one directory too high and report it broken.
      expect(
        results.find((r) => r.key === 'docs-links:modules/apidocs/docs/overview.md')?.status,
      ).toBe('pass')
    } finally {
      await scoped.cleanup()
    }
  })

  it('rejects backslash traversal in related entries and body links', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-backslash-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'docs/escape.md'),
        '---\ntype: context\nrelated: ["..\\\\..\\\\outside.md"]\n---\n# Escape\n\n[out](..\\\\..\\\\outside.md)\n',
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })

      expect(results.find((r) => r.key.startsWith('docs-related:docs/escape.md'))?.status).toBe(
        'fail',
      )
      expect(results.find((r) => r.key.startsWith('docs-link:docs/escape.md'))?.status).toBe('fail')
    } finally {
      await scoped.cleanup()
    }
  })

  it('warns on a status outside the OKF lifecycle values', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-status-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'docs/legacy.md'),
        '---\ntype: adr\nstatus: accepted\n---\n# Legacy status\n',
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })

      expect(results.find((r) => r.key === 'docs-status:docs/legacy.md')?.status).toBe('warn')
    } finally {
      await scoped.cleanup()
    }
  })

  it('warns when stale_after is not a real calendar date', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-stale-format-')
    try {
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(scoped.dir, 'docs/prose.md'),
        '---\ntype: context\nstale_after: tomorrow\n---\n# Prose\n',
        'utf8',
      )
      await writeFile(
        join(scoped.dir, 'docs/rolled.md'),
        '---\ntype: context\nstale_after: 2026-02-30\n---\n# Rolled\n',
        'utf8',
      )
      await writeFile(
        join(scoped.dir, 'docs/empty.md'),
        '---\ntype: context\nstale_after: ""\n---\n# Empty\n',
        'utf8',
      )
      await writeFile(
        join(scoped.dir, 'docs/blank.md'),
        '---\ntype: context\nstale_after:\n---\n# Blank\n',
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })

      // Silently unparseable dates would promise a freshness policy the
      // checker never enforces.
      expect(results.find((r) => r.key === 'docs-stale-after:docs/prose.md')?.status).toBe('warn')
      expect(results.find((r) => r.key === 'docs-stale-after:docs/rolled.md')?.status).toBe('warn')
      expect(results.find((r) => r.key === 'docs-stale-after:docs/empty.md')?.status).toBe('warn')
      expect(results.find((r) => r.key === 'docs-stale-after:docs/blank.md')?.status).toBe('warn')
    } finally {
      await scoped.cleanup()
    }
  })

  it('runs the union when --arch and --docs are combined', async () => {
    const report = await runCheck({ cwd: workspace.dir, arch: true, docs: true })

    expect(report.checks.some((c) => c.key.startsWith('docs-related:'))).toBe(true)
    expect(report.checks.some((c) => c.key.startsWith('manifest:'))).toBe(false)
    expect(report.failCount).toBeGreaterThan(0)
  })

  // Entity identity comes from the parsed class name; the filename fallback
  // would misreport a decorated model whose class name differs from it.
  it('resolves entities of a decorated model whose class name differs from its filename', async () => {
    const scoped = await createTempWorkspace('guren-cli-docs-decorators-')
    try {
      await mkdir(join(scoped.dir, 'app/Models'), { recursive: true })
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')

      await writeFile(
        join(scoped.dir, 'app/Models/Article.ts'),
        `@Entity()
export class BlogPost {
  @column accessor title = ''
}
`,
        'utf8',
      )
      await writeFile(
        join(scoped.dir, 'docs/blog-post.md'),
        `---
type: guide
entities: [BlogPost]
related:
  - app/Models/Article.ts
---
# Blog posts
`,
        'utf8',
      )

      const results = await runDocsCheck({ cwd: scoped.dir })

      expect(results.some((r) => r.key.startsWith('docs-entity:'))).toBe(false)
      expect(results.find((r) => r.key === 'docs-links:docs/blog-post.md')?.status).toBe('pass')
    } finally {
      await scoped.cleanup()
    }
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
