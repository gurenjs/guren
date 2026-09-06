import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  fetchLiveIssues,
  isRepoSlug,
  repoFromRemoteUrl,
  runGh,
  type GhResult,
  type GhRunner,
} from '../src/github'

describe('repoFromRemoteUrl', () => {
  it('reads owner/repo from the GitHub remote spellings', () => {
    expect(repoFromRemoteUrl('https://github.com/acme/shop.git')).toBe('acme/shop')
    expect(repoFromRemoteUrl('https://github.com/acme/shop')).toBe('acme/shop')
    expect(repoFromRemoteUrl('https://7nohe@github.com/acme/shop.git')).toBe('acme/shop')
    expect(repoFromRemoteUrl('git@github.com:acme/shop.git')).toBe('acme/shop')
    expect(repoFromRemoteUrl('ssh://git@github.com/acme/shop.git\n')).toBe('acme/shop')
  })

  it('returns null for remotes on other hosts', () => {
    expect(repoFromRemoteUrl('git@gitlab.com:acme/shop.git')).toBeNull()
    expect(repoFromRemoteUrl('https://github.com/acme')).toBeNull()
    expect(repoFromRemoteUrl('')).toBeNull()
  })
})

describe('isRepoSlug', () => {
  it('accepts owner/name and nothing else', () => {
    expect(isRepoSlug('acme/shop')).toBe(true)
    expect(isRepoSlug('acme-inc/shop.web')).toBe(true)
    for (const value of ['acme', 'acme/shop/extra', 'https://github.com/acme/shop', 'acme/ shop', '']) {
      expect(isRepoSlug(value)).toBe(false)
    }
  })
})

/** A directory holding a fake `gh`, put first on PATH for the duration of `fn`. */
async function withFakeGh<T>(script: string | null, fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'guren-cli-fake-gh-'))
  const originalPath = process.env.PATH
  try {
    if (script !== null) {
      writeFileSync(join(dir, 'gh'), `#!/bin/sh\n${script}\n`)
      chmodSync(join(dir, 'gh'), 0o755)
    }
    // An empty PATH tail makes a null script mean "no gh anywhere".
    process.env.PATH = script === null ? dir : `${dir}:${originalPath ?? ''}`
    return await fn(dir)
  } finally {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runGh', () => {
  it('returns stdout on a zero exit', async () => {
    const result = await withFakeGh('echo "{\\"data\\":1}"', (cwd) => runGh(['api'], cwd))
    expect(result).toEqual({ ok: true, stdout: '{"data":1}\n' })
  })

  it('reports the first stderr line of a failed exit', async () => {
    const result = await withFakeGh(
      'echo "" >&2; echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2; exit 4',
      (cwd) => runGh(['api'], cwd),
    )
    expect(result).toEqual({
      ok: false,
      reason: 'gh exited 4: gh: To get started with GitHub CLI, please run: gh auth login',
      stdout: '',
    })
  })

  it('keeps stdout on a failed exit, since a GraphQL error still prints the body', async () => {
    const result = await withFakeGh('echo "{\\"data\\":null}"; echo "gh: boom" >&2; exit 1', (cwd) =>
      runGh(['api'], cwd),
    )
    expect(result).toEqual({ ok: false, reason: 'gh exited 1: gh: boom', stdout: '{"data":null}\n' })
  })

  it('reports a missing binary rather than throwing', async () => {
    const result = await withFakeGh(null, (cwd) => runGh(['api'], cwd))
    expect(result).toEqual({ ok: false, reason: 'gh not found on PATH', stdout: '' })
  })

  it('gives up after the timeout', async () => {
    const result = await withFakeGh('sleep 5', (cwd) => runGh(['api'], cwd, 200))
    expect(result).toEqual({ ok: false, reason: 'gh timed out after 200ms', stdout: '' })
  })
})

describe('fetchLiveIssues', () => {
  const issue = (title: string, state: string, logins: string[] = [], labels: string[] = []) => ({
    title,
    state,
    assignees: { nodes: logins.map((login) => ({ login })) },
    labels: { nodes: labels.map((name) => ({ name })) },
    updatedAt: '2026-09-06T00:00:00Z',
  })

  it('asks once per repository and keys the answers by owner/repo#number', async () => {
    const calls: string[][] = []
    const run: GhRunner = async (args) => {
      calls.push(args)
      const repository =
        args.at(-1) === 'name=shop'
          ? { i412: issue('Verify email', 'OPEN', ['ada'], ['bug']), i7: issue('Old PR', 'MERGED'), i9: null }
          : { i1: issue('Elsewhere', 'CLOSED') }
      return { ok: true, stdout: JSON.stringify({ data: { repository } }) }
    }

    const lookup = await fetchLiveIssues(
      [
        { repo: 'acme/shop', number: 412 },
        { repo: 'acme/shop', number: 7 },
        { repo: 'acme/shop', number: 412 },
        { repo: 'acme/shop', number: 9 },
        { repo: 'acme/other', number: 1 },
      ],
      '/tmp',
      run,
    )

    expect(calls).toHaveLength(2)
    expect(calls[0].slice(0, 3)).toEqual(['api', 'graphql', '-f'])
    expect(calls[0][3]).toContain('i412: issueOrPullRequest(number: 412)')
    expect(calls[0][3]).toContain('i7: issueOrPullRequest(number: 7)')
    expect(calls[0][3]).not.toContain('body')
    expect(calls[0].slice(4)).toEqual(['-f', 'owner=acme', '-f', 'name=shop'])
    expect(lookup.error).toBeUndefined()
    expect(lookup.live.get('acme/shop#412')).toEqual({
      title: 'Verify email',
      state: 'open',
      assignees: ['ada'],
      labels: ['bug'],
      updatedAt: '2026-09-06T00:00:00Z',
    })
    expect(lookup.live.get('acme/shop#7')?.state).toBe('merged')
    expect(lookup.live.has('acme/shop#9')).toBe(false)
    expect(lookup.live.get('acme/other#1')?.state).toBe('closed')
  })

  it('stops at the first repository gh cannot answer for and keeps what it had', async () => {
    let calls = 0
    const run: GhRunner = async (): Promise<GhResult> => {
      calls += 1
      return calls === 1
        ? { ok: true, stdout: JSON.stringify({ data: { repository: { i1: issue('One', 'OPEN') } } }) }
        : { ok: false, reason: 'gh exited 4: not logged in', stdout: '' }
    }

    const lookup = await fetchLiveIssues(
      [
        { repo: 'acme/a', number: 1 },
        { repo: 'acme/b', number: 2 },
        { repo: 'acme/c', number: 3 },
      ],
      '/tmp',
      run,
    )

    expect(calls).toBe(2)
    expect(lookup.error).toBe('gh exited 4: not logged in')
    expect([...lookup.live.keys()]).toEqual(['acme/a#1'])
  })

  it('treats a body with no data as an error rather than an empty answer', async () => {
    const lookup = await fetchLiveIssues([{ repo: 'acme/a', number: 1 }], '/tmp', async () => ({
      ok: true,
      stdout: '<html>',
    }))
    expect(lookup.error).toBe('gh returned no data for acme/a')
  })

  it('reads the data a failed exit still printed, so one unknown number does not blank the rest', async () => {
    // What gh api graphql does for issueOrPullRequest(number: 999999): exit 1,
    // "Could not resolve" on stderr, and the other aliases in the body.
    const lookup = await fetchLiveIssues(
      [
        { repo: 'acme/a', number: 1 },
        { repo: 'acme/a', number: 999999 },
      ],
      '/tmp',
      async () => ({
        ok: false,
        reason: 'gh exited 1: gh: Could not resolve to an issue or pull request with the number of 999999.',
        stdout: JSON.stringify({ data: { repository: { i1: issue('One', 'OPEN'), i999999: null } } }),
      }),
    )
    expect(lookup.error).toBeUndefined()
    expect([...lookup.live.keys()]).toEqual(['acme/a#1'])
  })

  it('does not call gh at all for an empty target list', async () => {
    let calls = 0
    const lookup = await fetchLiveIssues([], '/tmp', async () => {
      calls += 1
      return { ok: true, stdout: '{}' }
    })
    expect(calls).toBe(0)
    expect(lookup).toEqual({ live: new Map() })
  })
})
