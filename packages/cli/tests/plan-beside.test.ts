import { describe, expect, test } from 'bun:test'

import { planBesideExclusions, planOutputPath } from '../src/plan/beside'

describe('planOutputPath', () => {
  test('should replace a .json extension', () => {
    expect(planOutputPath('/tmp/comments.plan.json')).toBe('/tmp/comments.plan.html')
  })

  test('should append to a path with no .json extension', () => {
    expect(planOutputPath('/tmp/plan')).toBe('/tmp/plan.html')
  })
})

describe('planBesideExclusions', () => {
  test('should exclude only the rendered page and its temporaries without records', () => {
    expect(planBesideExclusions('/app', '/app/docs/plans/comments/plan.json', { records: false })).toEqual([
      ':(exclude,literal)docs/plans/comments/plan.html',
      ':(exclude,glob)docs/plans/comments/.plan.html.*.tmp',
    ])
  })

  test('should add the plan, its approvals and its decision log with records', () => {
    const excluded = planBesideExclusions('/app', '/app/comments.plan.json', { records: true })

    expect(excluded.filter((pathspec) => pathspec.startsWith(':(exclude,literal)'))).toEqual([
      ':(exclude,literal)comments.plan.html',
      ':(exclude,literal)comments.plan.json',
      ':(exclude,literal)comments.approvals.json',
      ':(exclude,literal)comments.decisions.json',
    ])
  })

  test('should escape glob characters in a temporary pattern and skip a plan outside the root', () => {
    expect(planBesideExclusions('/app', '/app/[x]/plan.json', { records: false })[1]).toBe(':(exclude,glob)\\[x\\]/.plan.html.*.tmp')
    expect(planBesideExclusions('/app', '/elsewhere/plan.json', { records: true })).toEqual([])
  })
})
