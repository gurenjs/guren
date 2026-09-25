import { describe, expect, test } from 'bun:test'

import { isPlanRevisionsDirName, planBesideExclusions, planOutputPath, planRevisionsDir } from '../src/plan/beside'

describe('planOutputPath', () => {
  test('should replace a .json extension', () => {
    expect(planOutputPath('/tmp/comments.plan.json')).toBe('/tmp/comments.plan.html')
  })

  test('should append to a path with no .json extension', () => {
    expect(planOutputPath('/tmp/plan')).toBe('/tmp/plan.html')
  })
})

describe('planRevisionsDir', () => {
  test('should keep revisions under revisions/ in the §9 layout and <slug>.revisions/ beside any other plan', () => {
    expect(planRevisionsDir('/repo/docs/plans/comments/plan.json')).toBe('/repo/docs/plans/comments/revisions')
    expect(planRevisionsDir('/repo/comments.plan.json')).toBe('/repo/comments.revisions')
    expect(planRevisionsDir('/repo/comments.json')).toBe('/repo/comments.revisions')
  })

  test('should name a directory plan discovery skips, never a plan file name', () => {
    for (const plan of ['/repo/docs/plans/comments/plan.json', '/repo/comments.plan.json']) {
      const name = planRevisionsDir(plan).split('/').pop()!
      expect(isPlanRevisionsDirName(name)).toBe(true)
      expect(name === 'plan.json' || name.endsWith('.plan.json')).toBe(false)
    }
  })
})

describe('planBesideExclusions', () => {
  test('should exclude only the rendered page and its temporaries without records', () => {
    expect(planBesideExclusions('/app', '/app/docs/plans/comments/plan.json', { records: false })).toEqual([
      ':(exclude,literal)docs/plans/comments/plan.html',
      ':(exclude,glob)docs/plans/comments/.plan.html.*.tmp',
    ])
  })

  test('should add the plan, its approvals, its decision log and its revisions directory with records', () => {
    const excluded = planBesideExclusions('/app', '/app/comments.plan.json', { records: true })

    expect(excluded.filter((pathspec) => pathspec.startsWith(':(exclude,literal)'))).toEqual([
      ':(exclude,literal)comments.plan.html',
      ':(exclude,literal)comments.plan.json',
      ':(exclude,literal)comments.approvals.json',
      ':(exclude,literal)comments.decisions.json',
      ':(exclude,literal)comments.revisions',
    ])
    expect(planBesideExclusions('/app', '/app/docs/plans/comments/plan.json', { records: true })).toContain(':(exclude,literal)docs/plans/comments/revisions')
  })

  test('should escape glob characters in a temporary pattern and skip a plan outside the root', () => {
    expect(planBesideExclusions('/app', '/app/[x]/plan.json', { records: false })[1]).toBe(':(exclude,glob)\\[x\\]/.plan.html.*.tmp')
    expect(planBesideExclusions('/app', '/elsewhere/plan.json', { records: true })).toEqual([])
  })
})
