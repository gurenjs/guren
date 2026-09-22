import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { acceptanceIdNamesEntity, extractAcceptanceCitations, scanAcceptanceTests } from '../src/docs-acceptance'
import { runDocsCheck } from '../src/docs-check'
import { buildDocsGraphReport } from '../src/docs-graph'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'

describe('extractAcceptanceCitations', () => {
  it('should read a parenthesized id and a comma-separated group of them', () => {
    expect(extractAcceptanceCitations('- A rule. (AC-comments-1)\n- Another. (AC-comments-2, AC-comments-3)')).toEqual(['AC-comments-1', 'AC-comments-2', 'AC-comments-3'])
  })

  it('should not read brackets, prose in parentheses, or ids inside code', () => {
    const body = ['[AC-comments-1] is a test title', '(see AC-comments-2)', '(AC-comments-3, not an id)', '`(AC-comments-4)`', '```', '(AC-comments-5)', '```'].join('\n')

    expect(extractAcceptanceCitations(body)).toEqual([])
  })
})

describe('acceptanceIdNamesEntity', () => {
  it('should match the collection segment and the class name, and nothing else', () => {
    expect(acceptanceIdNamesEntity('AC-comments-4', 'Comment')).toBe(true)
    expect(acceptanceIdNamesEntity('AC-comment-4', 'Comment')).toBe(true)
    expect(acceptanceIdNamesEntity('AC-posts-1', 'Comment')).toBe(false)
    expect(acceptanceIdNamesEntity('AC-4', 'Comment')).toBe(false)
  })
})

describe('the doc → test relation', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-docs-acceptance-')
    await writeWorkspaceFiles(workspace.dir, {
      'package.json': '{}',
      'app/Models/Comment.ts': 'export class Comment {}\n',
      'tests/comments.test.ts': "test('[AC-comments-1] cited', () => {})\ntest('[AC-comments-2] nobody cites this', () => {})\ntest('[AC-posts-1] another entity', () => {})\n",
      'docs/entities/Comment.md': ['---', 'type: entity', 'entities: [Comment]', '---', '', '# Comment', '', '## Rules', '', '- Cited and tested. (AC-comments-1)', '- Cited, never tested. (AC-comments-7)', '- Cites nothing.', ''].join('\n'),
    })
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('should scan the ids test titles carry, with the files carrying them', async () => {
    expect(await scanAcceptanceTests(workspace.dir)).toEqual([
      { id: 'AC-comments-1', files: ['tests/comments.test.ts'] },
      { id: 'AC-comments-2', files: ['tests/comments.test.ts'] },
      { id: 'AC-posts-1', files: ['tests/comments.test.ts'] },
    ])
  })

  it('should warn on a citation no test carries, a test its entity documents skip, and a rule citing nothing', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })
    const byKey = Object.fromEntries(results.map((result) => [result.key, result.status]))

    expect(byKey['docs-cites:docs/entities/Comment.md:AC-comments-1']).toBe('pass')
    expect(byKey['docs-cites:docs/entities/Comment.md:AC-comments-7']).toBe('warn')
    expect(byKey['docs-uncited-test:AC-comments-2']).toBe('warn')
    // No document cites a posts behaviour, so nothing says one should.
    expect(byKey['docs-uncited-test:AC-posts-1']).toBeUndefined()
    expect(results.filter((result) => result.key.startsWith('docs-rule-uncited:')).map((result) => result.message)).toEqual([
      'The rule "Cites nothing." cites no acceptance id, so no test is known to verify it.',
    ])
    expect(results.some((result) => result.status === 'fail')).toBe(false)
  })

  it('should narrow the graph to an entity with the tests that verify it', async () => {
    const report = await buildDocsGraphReport({ cwd: workspace.dir, entity: 'Comment' })

    expect(report.edges.filter((edge) => edge.relation === 'verifies' && edge.to === 'entity:Comment')).toEqual([
      { from: 'test:AC-comments-1', to: 'entity:Comment', relation: 'verifies', verdict: 'pass' },
      { from: 'test:AC-comments-2', to: 'entity:Comment', relation: 'verifies', verdict: 'warn' },
      { from: 'test:AC-comments-7', to: 'entity:Comment', relation: 'verifies', verdict: 'warn' },
    ])
  })
})
