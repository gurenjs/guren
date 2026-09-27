import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { acceptanceIdEntity, extractAcceptanceCitations, scanAcceptanceTests } from '../src/docs-acceptance'
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

describe('acceptanceIdEntity', () => {
  it('should match the collection segment and the class name, and nothing else', () => {
    expect(acceptanceIdEntity('AC-comments-4', ['Comment'])).toBe('Comment')
    expect(acceptanceIdEntity('AC-comment-4', ['Comment'])).toBe('Comment')
    expect(acceptanceIdEntity('AC-posts-1', ['Comment'])).toBeUndefined()
    expect(acceptanceIdEntity('AC-4', ['Comment'])).toBeUndefined()
  })

  it('should read the entity a task-named id leads with', () => {
    expect(acceptanceIdEntity('AC-meetups-host-1', ['Meetup'])).toBe('Meetup')
    expect(acceptanceIdEntity('AC-meetups-host-1', ['Host'])).toBeUndefined()
    expect(acceptanceIdEntity('AC-Meetup-edit-10', ['Meetup'])).toBe('Meetup')
  })

  it('should take a name only as whole dash-separated segments followed by more of the id', () => {
    expect(acceptanceIdEntity('AC-commentsx-1', ['Comment'])).toBeUndefined()
    expect(acceptanceIdEntity('AC-comments-', ['Comment'])).toBeUndefined()
    expect(acceptanceIdEntity('AC-comments', ['Comment'])).toBeUndefined()
  })

  it('should prefer the entity with the longest name the id leads with', () => {
    expect(acceptanceIdEntity('AC-post-comments-1', ['Post', 'PostComment'])).toBe('PostComment')
    expect(acceptanceIdEntity('AC-post-comments-1', ['PostComment', 'Post'])).toBe('PostComment')
    expect(acceptanceIdEntity('AC-posts-edit-1', ['Post', 'PostComment'])).toBe('Post')
    expect(acceptanceIdEntity('AC-postComments-1', ['Post', 'PostComment'])).toBe('PostComment')
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

describe('the doc → test relation for task-named ids', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-docs-acceptance-task-')
    await writeWorkspaceFiles(workspace.dir, {
      'package.json': '{}',
      'app/Models/Meetup.ts': 'export class Meetup {}\n',
      'tests/meetups.test.ts': "test('[AC-meetups-host-1] cited', () => {})\ntest('[AC-meetups-host-2] nobody cites this', () => {})\ntest('[AC-meetups-browse-1] another task', () => {})\n",
      'docs/entities/Meetup.md': ['---', 'type: entity', 'entities: [Meetup]', '---', '', '# Meetup', '', '## Rules', '', '- A host creates a meetup. (AC-meetups-host-1)', ''].join('\n'),
    })
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('should warn on every test of the entity its documents skip, whichever task it belongs to', async () => {
    const results = await runDocsCheck({ cwd: workspace.dir })
    const byKey = Object.fromEntries(results.map((result) => [result.key, result]))

    expect(byKey['docs-cites:docs/entities/Meetup.md:AC-meetups-host-1']?.status).toBe('pass')
    expect(byKey['docs-uncited-test:AC-meetups-host-1']).toBeUndefined()
    expect(byKey['docs-uncited-test:AC-meetups-host-2']?.status).toBe('warn')
    expect(byKey['docs-uncited-test:AC-meetups-host-2']?.message).toBe('tests/meetups.test.ts carries [AC-meetups-host-2], and documents cite other Meetup behaviours but not this one.')
    expect(byKey['docs-uncited-test:AC-meetups-browse-1']?.status).toBe('warn')
  })

  it('should draw a verifies edge from each test to the entity its id leads with', async () => {
    const report = await buildDocsGraphReport({ cwd: workspace.dir, entity: 'Meetup' })

    expect(report.edges.filter((edge) => edge.relation === 'verifies' && edge.to === 'entity:Meetup')).toEqual([
      { from: 'test:AC-meetups-browse-1', to: 'entity:Meetup', relation: 'verifies', verdict: 'warn' },
      { from: 'test:AC-meetups-host-1', to: 'entity:Meetup', relation: 'verifies', verdict: 'pass' },
      { from: 'test:AC-meetups-host-2', to: 'entity:Meetup', relation: 'verifies', verdict: 'warn' },
    ])
  })
})
