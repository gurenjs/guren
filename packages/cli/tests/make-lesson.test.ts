import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runDocsCheck } from '../src/docs-check'
import { scanDocs } from '../src/docs-index'
import { generateEntityContext, renderEntityContextMarkdown } from '../src/entity-context'
import { makeLesson } from '../src/make-lesson'
import { reproduceLesson } from '../src/lesson-reproduce'
import { createTempWorkspace } from './helpers'

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr}`)
  return stdout.trim()
}

const lessonDoc = (frontmatter: string): string => `---\ntype: lesson\n${frontmatter}\n---\n\n# A lesson\n`

describe('makeLesson', () => {
  it('writes a numbered draft lesson with the rule, its entity, paths and a review date', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-lesson-')
    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')

      const file = await makeLesson('Load a comment through its post', { entity: 'Post', rule: 'Load a comment through its post, never by id alone.', paths: ['app/Http/**'], from: '#412', by: 'test-agent/1.0' })
      const content = readFileSync(file, 'utf8')

      expect(file).toContain('docs/lessons/0001-load-a-comment-through-its-post.md')
      expect(content).toContain('type: lesson\nstatus: draft\nrule: "Load a comment through its post, never by id alone."\nentities: [Post]\npaths: ["app/Http/**"]\nsource: { pr: 412, kind: review-finding }\n')
      expect(content).toMatch(/^review: \d{4}-\d{2}-\d{2}$/m)
      expect((await makeLesson('Second one')).endsWith('0002-second-one.md')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reads a commit, and a revert, from --from', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-lesson-from-')
    try {
      await git(workspace.dir, ['init', '--initial-branch=main'])
      await git(workspace.dir, ['config', 'user.email', 'test@example.com'])
      await git(workspace.dir, ['config', 'user.name', 'Test'])
      await git(workspace.dir, ['commit', '--allow-empty', '-m', 'Revert "feat: something"'])
      const sha = await git(workspace.dir, ['rev-parse', 'HEAD'])

      const content = readFileSync(await makeLesson('Reverted', { from: sha }), 'utf8')

      expect(content).toContain(`source: { commit: ${sha.slice(0, 12)}, kind: revert }`)
      await expect(makeLesson('Unknown', { from: 'deadbeefcafe' })).rejects.toThrow('neither a pull request number nor a commit')
      // Bare digits are a pull request unless git reads them as this repository's commit.
      expect(readFileSync(await makeLesson('Bare number', { from: '412' }), 'utf8')).toContain('source: { pr: 412, kind: review-finding }')
      await expect(makeLesson('Kind alone', { kind: 'revert' })).rejects.toThrow('--kind says what --from came from')
    } finally {
      await workspace.cleanup()
    }
  })

  it('writes --enforced-by and a not-run reproduced wherever no commit can be run, and refuses a check that does not exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-lesson-enforced-')
    try {
      await mkdir(join(workspace.dir, 'tests'), { recursive: true })
      await writeFile(join(workspace.dir, 'tests/posts.test.ts'), "test('page 2 [fix-page-2]', () => {})\n", 'utf8')
      const enforcedBy = 'tests/posts.test.ts#fix-page-2'

      const fromPr = readFileSync(await makeLesson('From a pull request', { from: '#412', enforcedBy }), 'utf8')
      expect(fromPr).toContain(`enforcedBy: "${enforcedBy}"\nreproduced: not-run\nreproducedBecause: "--from #412 names a pull request, whose commits this does not read"\n`)
      expect(fromPr).not.toContain('name it in enforcedBy')
      expect(readFileSync(await makeLesson('No source', { enforcedBy }), 'utf8')).toContain('reproducedBecause: "no --from names the commit that removed the defect"')
      expect(readFileSync(await makeLesson('Skipped', { from: '#1', enforcedBy, reproduce: false }), 'utf8')).toContain('reproducedBecause: "make:lesson ran with --no-reproduce"')

      await expect(makeLesson('Missing name', { enforcedBy: 'tests/posts.test.ts#fix-page' })).rejects.toThrow('does not hold fix-page')
      await expect(makeLesson('Missing file', { enforcedBy: 'tests/none.test.ts#x' })).rejects.toThrow('which is not a file in the application')
      await expect(makeLesson('Outside', { enforcedBy: '../tests/posts.test.ts#fix-page-2' })).rejects.toThrow('which is not a file in the application')
      await expect(makeLesson('No name', { enforcedBy: 'tests/posts.test.ts' })).rejects.toThrow('names no check')
    } finally {
      await workspace.cleanup()
    }
  })

  it('runs only a test file as the reproducing check', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-lesson-arch-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), "export default { 'controllers-no-drizzle': {} }\n", 'utf8')
      expect(await reproduceLesson(workspace.dir, 'deadbeef', 'guren.arch.ts#controllers-no-drizzle')).toEqual({ value: 'not-run', because: 'guren.arch.ts is not a test file, and only a test is run' })
    } finally {
      await workspace.cleanup()
    }
  })

  it('refuses a rule past one line and a value that would break the frontmatter', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-lesson-refuse-')
    try {
      await expect(makeLesson('Too long', { rule: 'x'.repeat(161) })).rejects.toThrow('one line of 1 to 160')
      await expect(makeLesson('Quote', { rule: 'a "quoted" rule' })).rejects.toThrow('Invalid rule')
      await expect(makeLesson('Kind', { from: '#1', kind: 'gossip' as never })).rejects.toThrow('--kind is one of')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('lessons in check --docs', () => {
  it('fails a missing or long rule and an enforcedBy that names nothing, and warns on a passed review date', async () => {
    const workspace = await createTempWorkspace('guren-cli-lesson-check-')
    try {
      await mkdir(join(workspace.dir, 'docs/lessons'), { recursive: true })
      await mkdir(join(workspace.dir, 'tests'), { recursive: true })
      await writeFile(join(workspace.dir, 'tests/posts.test.ts'), "test('[AC-posts-1] loads through its post', () => {})\ntest('[AC-posts-12] lists them', () => {})\n", 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0001-ok.md'), lessonDoc('status: stable\nrule: "Load through the post"\nenforcedBy: tests/posts.test.ts#AC-posts-1\nreview: 2999-01-01'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0002-norule.md'), lessonDoc('status: stable'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0003-long.md'), lessonDoc(`rule: "${'x'.repeat(161)}"`), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0004-enforced.md'), lessonDoc('rule: "r"\nenforcedBy: tests/posts.test.ts#AC-posts-9'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0005-missing.md'), lessonDoc('rule: "r"\nenforcedBy: guren.arch.ts#controllers-no-drizzle'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0006-old.md'), lessonDoc('status: stable\nrule: "r"\nreview: 2020-01-01'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0007-retired.md'), lessonDoc('status: deprecated\nrule: "r"'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0008-prefix.md'), lessonDoc('rule: "r"\nenforcedBy: tests/posts.test.ts#AC-posts-1'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0009-noname.md'), lessonDoc('rule: "r"\nenforcedBy: tests/posts.test.ts'), 'utf8')

      const results = (await runDocsCheck({ cwd: workspace.dir })).filter((result) => result.key.startsWith('docs-lesson-'))
      const byKey = Object.fromEntries(results.map((result) => [result.key, result.status]))

      expect(byKey).toEqual({
        'docs-lesson-rule:docs/lessons/0002-norule.md': 'fail',
        'docs-lesson-rule:docs/lessons/0003-long.md': 'fail',
        'docs-lesson-enforced:docs/lessons/0004-enforced.md': 'fail',
        'docs-lesson-enforced:docs/lessons/0005-missing.md': 'fail',
        'docs-lesson-review:docs/lessons/0006-old.md': 'warn',
        'docs-lesson-superseded:docs/lessons/0007-retired.md': 'warn',
        'docs-lesson-enforced:docs/lessons/0009-noname.md': 'fail',
      })

      // A whole token: once AC-posts-1 is gone, AC-posts-12 does not keep it standing.
      await writeFile(join(workspace.dir, 'tests/posts.test.ts'), "test('[AC-posts-12] lists them', () => {})\n", 'utf8')
      const scoped = await runDocsCheck({ cwd: workspace.dir, changedFiles: new Set(['tests/posts.test.ts']) })
      expect(scoped.filter((result) => result.key.startsWith('docs-lesson-enforced:')).map((result) => result.key).sort()).toEqual([
        'docs-lesson-enforced:docs/lessons/0001-ok.md',
        'docs-lesson-enforced:docs/lessons/0004-enforced.md',
        'docs-lesson-enforced:docs/lessons/0008-prefix.md',
        'docs-lesson-enforced:docs/lessons/0009-noname.md',
      ])
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('lessons check --docs cannot read', () => {
  it('fails a block-scalar rule and an enforcedBy that is not one value, reads the name past the first #, and warns on an impossible date', async () => {
    const workspace = await createTempWorkspace('guren-cli-lesson-unread-')
    try {
      await mkdir(join(workspace.dir, 'docs/lessons'), { recursive: true })
      await mkdir(join(workspace.dir, 'tests'), { recursive: true })
      await writeFile(join(workspace.dir, 'tests/auth.test.ts'), "test('[AC-auth-1] signs in', () => {})\n", 'utf8')
      const files: Record<string, string> = {
        'block.md': lessonDoc(`status: stable\nrule: |\n  ${'x'.repeat(200)}`),
        'list.md': lessonDoc('rule: "r"\nenforcedBy: [tests/missing.test.ts#AC-auth-1]'),
        'empty.md': lessonDoc('rule: "r"\nenforcedBy:'),
        'hash.md': lessonDoc('rule: "r"\nenforcedBy: tests/auth.test.ts#AC-auth-1#removed'),
        'date.md': lessonDoc('status: stable\nrule: "r"\nreview: 2027-02-30'),
      }
      for (const [name, content] of Object.entries(files)) await writeFile(join(workspace.dir, 'docs/lessons', name), content, 'utf8')

      const results = (await runDocsCheck({ cwd: workspace.dir })).filter((result) => result.key.startsWith('docs-lesson-'))

      expect(Object.fromEntries(results.map((result) => [result.key.replace('docs/lessons/', ''), result.status]))).toEqual({
        'docs-lesson-rule:block.md': 'fail',
        'docs-lesson-enforced:list.md': 'fail',
        'docs-lesson-enforced:empty.md': 'fail',
        'docs-lesson-enforced:hash.md': 'fail',
        'docs-lesson-review:date.md': 'warn',
      })
      expect((await scanDocs(workspace.dir)).find((ref) => ref.path.endsWith('block.md'))?.lesson?.rule).toBe('')
    } finally {
      await workspace.cleanup()
    }
  })

  it('brings a lesson into a --changed run when a path it governs changed', async () => {
    const workspace = await createTempWorkspace('guren-cli-lesson-paths-scope-')
    try {
      await mkdir(join(workspace.dir, 'docs/lessons'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Http/Controllers/PostController.ts'), 'export class PostController {}\n', 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0001-http.md'), lessonDoc('status: stable\nrule: "r"\npaths: ["app/Http/**"]\nreview: 2020-01-01'), 'utf8')

      const scoped = await runDocsCheck({ cwd: workspace.dir, changedFiles: new Set(['app/Http/Controllers/PostController.ts']) })

      expect(scoped.map((result) => result.key)).toContain('docs-lesson-review:docs/lessons/0001-http.md')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('lessons in guren context', () => {
  it('prints a stable lesson\'s rule and nothing of a draft one', async () => {
    const workspace = await createTempWorkspace('guren-cli-lesson-context-')
    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await mkdir(join(workspace.dir, 'docs/lessons'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0001-stable.md'), lessonDoc('status: stable\nrule: "Load a comment through its post"\nentities: [Post]'), 'utf8')
      await writeFile(join(workspace.dir, 'docs/lessons/0002-draft.md'), lessonDoc('status: draft\nrule: "Not yet accepted"\nentities: [Post]'), 'utf8')

      const refs = await scanDocs(workspace.dir)
      expect(refs.find((ref) => ref.path === 'docs/lessons/0001-stable.md')?.lesson).toEqual({ rule: 'Load a comment through its post', paths: [] })

      const md = renderEntityContextMarkdown(await generateEntityContext('Post', { cwd: workspace.dir }))
      expect(md).toContain('## Lessons (1)\n- Load a comment through its post (docs/lessons/0001-stable.md)')
      expect(md).not.toContain('Not yet accepted')
    } finally {
      await workspace.cleanup()
    }
  })
})
