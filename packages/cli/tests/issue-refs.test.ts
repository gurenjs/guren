import { describe, expect, it } from 'bun:test'
import { describeIssue, parseIssueRef, repoFromRemoteUrl, splitIssueList } from '../src/issue-refs'

describe('parseIssueRef', () => {
  it('accepts a bare number as the app-repository form', () => {
    expect(parseIssueRef('412')).toEqual({ kind: 'github', repo: null, number: 412 })
    expect(parseIssueRef('#412')).toEqual({ kind: 'github', repo: null, number: 412 })
    expect(parseIssueRef('  412 ')).toEqual({ kind: 'github', repo: null, number: 412 })
  })

  it('accepts owner/repo#number', () => {
    expect(parseIssueRef('acme/shop#398')).toEqual({ kind: 'github', repo: 'acme/shop', number: 398 })
    expect(parseIssueRef('acme-inc/shop.web#1')).toEqual({ kind: 'github', repo: 'acme-inc/shop.web', number: 1 })
  })

  it('parses GitHub issue and pull request URLs, ignoring fragments', () => {
    expect(parseIssueRef('https://github.com/acme/shop/issues/412')).toEqual({
      kind: 'github',
      repo: 'acme/shop',
      number: 412,
    })
    expect(parseIssueRef('https://github.com/acme/shop/pull/9#issuecomment-1')).toEqual({
      kind: 'github',
      repo: 'acme/shop',
      number: 9,
    })
    expect(parseIssueRef('http://www.github.com/acme/shop/issues/2')).toMatchObject({ number: 2 })
  })

  it('keeps a non-GitHub URL as an outlink', () => {
    expect(parseIssueRef('https://gitlab.example.com/acme/shop/-/issues/5')).toEqual({
      kind: 'url',
      url: 'https://gitlab.example.com/acme/shop/-/issues/5',
    })
  })

  it('rejects anything else', () => {
    for (const raw of ['', 'next-sprint', 'shop#12', 'acme/shop#', 'acme/shop/12', '12a', 'ftp://x/1', 'https://x y']) {
      expect(parseIssueRef(raw)).toBeNull()
    }
  })

  it('rejects the characters that would break a quoted YAML scalar or a comma list', () => {
    for (const raw of [
      'https://github.com/acme/shop/issues/412?", evil: true',
      'https://github.com/acme/shop/issues/412?a=1,2',
      'https://github.com/acme/shop/issues/412#\\x',
      'https://gitlab.example.com/i/5?q="x"',
      'https://gitlab.example.com/i/5,6',
    ]) {
      expect(parseIssueRef(raw)).toBeNull()
    }
  })

  it('never yields a non-http(s) URL, which is what keeps viewer hrefs safe', () => {
    expect(parseIssueRef('javascript:alert(1)')).toBeNull()
    expect(parseIssueRef('data:text/html,x')).toBeNull()
  })

  it('rejects zero and numbers beyond the safe-integer range', () => {
    expect(parseIssueRef('0')).toBeNull()
    expect(parseIssueRef('#0')).toBeNull()
    expect(parseIssueRef('acme/shop#0')).toBeNull()
    expect(parseIssueRef('99999999999999999999')).toBeNull()
    expect(parseIssueRef('0412')).toMatchObject({ number: 412 })
  })
})

describe('splitIssueList', () => {
  it('splits the --issue value on commas and drops blanks', () => {
    expect(splitIssueList(undefined)).toEqual([])
    expect(splitIssueList('412')).toEqual(['412'])
    expect(splitIssueList(' 412, acme/shop#7 ,, ')).toEqual(['412', 'acme/shop#7'])
  })
})

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

describe('describeIssue', () => {
  const bare = parseIssueRef('412')!
  const scoped = parseIssueRef('acme/shop#412')!
  const url = parseIssueRef('https://gitlab.example.com/i/5')!

  it('fills the app repository in from the default, so two spellings of one issue share a label', () => {
    expect(describeIssue(bare, 'acme/shop')).toEqual({
      label: 'acme/shop#412',
      url: 'https://github.com/acme/shop/issues/412',
    })
    expect(describeIssue(bare, 'acme/shop')).toEqual(describeIssue(scoped, null))
  })

  it('degrades to a bare label with no URL when no repository is known', () => {
    expect(describeIssue(bare, null)).toEqual({ label: '#412' })
  })

  it('passes URL entries through unchanged', () => {
    expect(describeIssue(url, 'acme/shop')).toEqual({
      label: 'https://gitlab.example.com/i/5',
      url: 'https://gitlab.example.com/i/5',
    })
  })
})
