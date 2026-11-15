import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ChangeFact } from '../src/change/lane'
import { judgeChangeLane, type ChangeLaneReport } from '../src/change/lane'
import { openChange, resolveChange, type ChangedPath } from '../src/change/resolve'
import { applyReviewPolicy, readReviewPolicySource } from '../src/change/review-policy'
import { renderChangeLane } from '../src/commands/change'
import { defineReviewPolicy } from '../src/review/index'
import { createTempRoot, PG_SCHEMA_FIXTURE } from './helpers'

let ROOT: string
let repos = 0

beforeAll(async () => {
  ROOT = await createTempRoot('guren-review-policy-')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with code ${code}: ${stderr}`)
  return stdout.trim()
}

async function commit(repo: string, files: Record<string, string | null>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(repo, path))
      continue
    }
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content, 'utf8')
  }
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '--allow-empty', '-m', 'change'])
  return git(repo, ['rev-parse', 'HEAD'])
}

const BASE_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'bun test' } }, null, 2),
  'db/schema.ts': PG_SCHEMA_FIXTURE,
  'app/Http/Controllers/PostController.ts': 'export class PostController {}\n',
  'config/app.ts': 'export default {}\n',
}

const policySource = (body: string): string => `import { defineReviewPolicy } from '@guren/cli/review'\n\nexport default defineReviewPolicy(${body})\n`

/** The lane of one commit on a base that carries `policy` as its `guren.review.ts`. */
async function laneWithPolicy(policy: string | null, files: Record<string, string | null>): Promise<ChangeLaneReport> {
  const repo = join(ROOT, `repo-${repos++}`)
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test'])
  const base = await commit(repo, { ...BASE_FILES, ...(policy === null ? {} : { 'guren.review.ts': policy }) })
  const head = await commit(repo, files)
  const change = await resolveChange(repo, base, head)
  const { reader, dispose } = openChange(repo, change)
  try {
    return await judgeChangeLane(change, reader)
  } finally {
    await dispose()
  }
}

const unreadable = (source: string): string => {
  const loaded = readReviewPolicySource(source)
  if (loaded.state !== 'unreadable') throw new Error(`expected the policy to be refused, got ${JSON.stringify(loaded)}`)
  return loaded.reason
}

describe('readReviewPolicySource', () => {
  test('should read the policy the RFC shows, through an aliased import and a satisfies clause', () => {
    const source = `import { defineReviewPolicy as review } from '@guren/cli/review'

export default review({
  approvals: { low: 0, medium: 1, high: 2 },
  paths: { high: ['app/Billing/**', 'config/session.ts'], medium: 'config/**' },
  facts: { 'agent-tool': 'high', 'schema-changed': 'low' },
  review: { reviewer: 'claude-code-review', timeoutMinutes: 60 },
  identities: 'auto',
  merge: { low: \`lane-job\` },
}) satisfies object
`

    expect(readReviewPolicySource(source)).toEqual({
      state: 'read',
      policy: {
        approvals: { low: 0, medium: 1, high: 2 },
        paths: { high: ['app/Billing/**', 'config/session.ts'], medium: 'config/**' },
        facts: { 'agent-tool': 'high', 'schema-changed': 'low' },
        review: { reviewer: 'claude-code-review', timeoutMinutes: 60 },
        identities: 'auto',
        merge: { low: 'lane-job' },
      },
    })
  })

  test('should read a bare object literal and a reviewer named by its check', () => {
    expect(readReviewPolicySource("export default { review: { reviewer: { check: 'Review', app: 'reviewer-app', conclusion: 'success' } } } as const\n")).toEqual({
      state: 'read',
      policy: { review: { reviewer: { check: 'Review', app: 'reviewer-app', conclusion: 'success' } } },
    })
  })

  test('should refuse a value it would have to run the file to know', () => {
    expect(unreadable(`const HIGH = ['app/**']\n${policySource('{ paths: { high: HIGH } }')}`)).toContain('paths.high (line 4) is the name HIGH')
    expect(unreadable(policySource("{ paths: { high: [...['app/**']] } }"))).toContain('paths.high[0]')
    expect(unreadable(policySource('{ ...{ identities: "auto" } }'))).toContain('a spread, a method or a computed key')
    expect(unreadable("const policy = { identities: 'auto' }\nexport default policy\n")).toContain('is not `defineReviewPolicy({ … })`')
    expect(unreadable("export const policy = { identities: 'auto' }\n")).toContain('has no default export')
    expect(unreadable('export default {')).toBe('it does not parse')
  })

  test('should refuse a key it does not know rather than apply the rest', () => {
    expect(unreadable(policySource("{ fact: { 'agent-tool': 'high' } }"))).toContain('`fact`')
    expect(unreadable(policySource("{ facts: { 'agent-tol': 'high' } }"))).toContain('`agent-tol`')
    expect(unreadable(policySource("{ facts: { 'review-path': 'low' } }"))).toContain('`review-path`')
    expect(unreadable(policySource("{ paths: { low: ['docs/**'] } }"))).toContain('`low`')
    expect(unreadable(policySource("{ facts: { 'schema-changed': 'none' } }"))).toContain('facts.schema-changed is not')
    expect(unreadable(policySource('{ approvals: { medium: 1.5 } }'))).toContain('approvals.medium is not a whole number')
    expect(unreadable(policySource("{ paths: { high: [] } }"))).toContain('paths.high is not a glob')
    expect(unreadable(policySource("{ review: { reviewer: 'coderabbit' } }"))).toContain('review.reviewer')
    expect(unreadable(policySource("{ identities: 'one' }"))).toContain('identities')
    expect(unreadable(policySource("{ merge: { low: 'auto' } }"))).toContain('merge.low')
  })

  test('should refuse lowering a fact below the lane a declaration gives it', () => {
    expect(unreadable(policySource("{ facts: { 'gate-input': 'medium' } }"))).toContain('lowers an always-high fact')
    expect(unreadable(policySource("{ facts: { 'source-edited': 'low' } }"))).toContain('stays medium whatever a plan or the policy says')
    expect(unreadable(policySource("{ facts: { 'policy-changed': 'low' } }"))).toContain('no lower than medium')
    expect(readReviewPolicySource(policySource("{ facts: { 'policy-changed': 'medium', 'gate-input': 'high', 'ambient': 'medium' } }")).state).toBe('read')
  })
})

describe('applyReviewPolicy', () => {
  const fact = (code: ChangeFact['code'], lane: ChangeFact['lane'], files: string[]): ChangeFact => ({ code, lane, files, evidence: 'path', message: files.join(', ') })
  const path = (value: string, extra: Partial<ChangedPath> = {}): ChangedPath => ({ path: value, status: 'modified', ...extra })

  test('should set a named fact to its lane and keep the lane it had', () => {
    const facts = applyReviewPolicy([fact('schema-changed', 'medium', ['db/schema.ts']), fact('ambient', 'low', ['README.md']), fact('source-edited', 'medium', ['app/x.ts'])], [], {
      facts: { 'schema-changed': 'low', ambient: 'medium', 'source-edited': 'medium' },
    })

    expect(facts.map(({ code, lane, policyFrom }) => [code, lane, policyFrom])).toEqual([
      ['schema-changed', 'low', 'medium'],
      ['ambient', 'medium', 'low'],
      ['source-edited', 'medium', undefined],
    ])
  })

  test('should give each glob its own fact, a path matched by a high glob claimed by it alone', () => {
    const paths = [
      path('app/Billing/Invoice.ts'),
      path('config/session.ts'),
      path('config/app.ts'),
      path('app/Pay/Charge.ts', { status: 'renamed', oldPath: 'app/Billing/Charge.ts' }),
      path('config/elsewhere.ts', { outsideApp: true }),
    ]

    const facts = applyReviewPolicy([], paths, { paths: { high: ['app/Billing/**', 'config/session.ts'], medium: 'config/**' } })

    expect(facts.map(({ code, lane, target, files }) => [code, lane, target, files])).toEqual([
      ['review-path', 'high', 'app/Billing/**', ['app/Billing/Invoice.ts', 'app/Pay/Charge.ts']],
      ['review-path', 'high', 'config/session.ts', ['config/session.ts']],
      ['review-path', 'medium', 'config/**', ['config/app.ts']],
    ])
  })
})

describe('judgeChangeLane with guren.review.ts', () => {
  test('should apply the merge base\'s policy to the floor and say so', async () => {
    const report = await laneWithPolicy(policySource("{ facts: { 'schema-changed': 'low' }, paths: { high: ['config/**'] } }"), {
      'db/schema.ts': `${PG_SCHEMA_FIXTURE}\nexport const tags = pgTable('tags', { id: serial('id').primaryKey() })\n`,
    })

    expect(report.policy.state).toBe('read')
    expect(report.facts.map(({ code, lane, policyFrom }) => [code, lane, policyFrom])).toEqual([['schema-changed', 'low', 'medium']])
    expect(renderChangeLane(report)).toContain('(lowered by guren.review.ts from medium)')
    expect(renderChangeLane(report)).toContain('guren.review.ts applied as the merge base has it')

    const raised = await laneWithPolicy(policySource("{ paths: { high: ['config/**'] } }"), { 'config/app.ts': 'export default { debug: true }\n' })
    expect(raised.floor).toBe('high')
    expect(raised.facts.map(({ code, lane }) => [code, lane])).toEqual([['source-edited', 'medium'], ['review-path', 'high']])
  })

  test('should not apply the policy a change brings, which is a gate input', async () => {
    const report = await laneWithPolicy(null, { 'guren.review.ts': policySource("{ facts: { 'gate-input': 'high', 'file-added': 'low' } }"), 'app/New.ts': 'export {}\n' })

    expect(report.policy).toEqual({ state: 'absent' })
    expect(report.facts.map(({ code, lane }) => [code, lane]).sort()).toEqual([['file-added', 'medium'], ['gate-input', 'high']])
  })

  test('should hold the change at high and lower nothing when the base\'s policy does not read', async () => {
    const report = await laneWithPolicy(`const LOW = 'low'\n${policySource("{ facts: { 'file-added': LOW } }")}`, { 'app/New.ts': 'export {}\n' })

    expect(report.policy.state).toBe('unreadable')
    expect(report.floor).toBe('high')
    expect(report.facts.map(({ code, lane }) => [code, lane])).toEqual([['file-added', 'medium']])
    expect(report.unjudged).toContainEqual(expect.objectContaining({ reader: 'review-policy', lane: 'high', files: ['guren.review.ts'] }))
  })
})

describe('defineReviewPolicy', () => {
  test('should hand the policy back unchanged', () => {
    const policy = { identities: 'one-owner', merge: { low: 'person' } } as const

    expect(defineReviewPolicy(policy)).toBe(policy)
  })
})
