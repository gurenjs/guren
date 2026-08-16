import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  auditReleasePlan,
  ChangesetParseError,
  parseChangeset,
  readChangesetDirectory,
  type ParsedChangeset,
} from './core-semver-audit'

function changeset(file: string, ...lines: string[]): ParsedChangeset {
  return parseChangeset(file, `---\n${lines.join('\n')}\n---\n\nA change.\n`)
}

describe('parseChangeset', () => {
  test('reads both quoting styles the repository has actually committed', () => {
    // `align-rc10.md` used double quotes, `cloudflare-jsonc-upgrade-warning.md`
    // single. The changesets CLI writes one; humans edit in the other.
    const parsed = parseChangeset(
      'mixed.md',
      ['---', '"@guren/server": major', "'@guren/core': major", '---', '', 'body'].join('\n'),
    )

    expect(parsed.releases.get('@guren/server')).toBe('major')
    expect(parsed.releases.get('@guren/core')).toBe('major')
  })

  test('tolerates CRLF and a body containing a --- rule', () => {
    const parsed = parseChangeset(
      'crlf.md',
      '---\r\n"@guren/server": minor\r\n---\r\n\r\nA change.\r\n\r\n---\r\n\r\nMore.\r\n',
    )

    expect([...parsed.releases]).toEqual([['@guren/server', 'minor']])
  })

  test('refuses a file with no frontmatter rather than reading it as empty', () => {
    expect(() => parseChangeset('prose.md', 'Just a note about the release.\n')).toThrow(
      ChangesetParseError,
    )
  })

  test('refuses an unknown bump type', () => {
    expect(() => changeset('typo.md', '"@guren/server": mayor')).toThrow(ChangesetParseError)
  })

  test('refuses a frontmatter line that is not a release entry', () => {
    expect(() => changeset('stray.md', '"@guren/server": major', 'note: see PR')).toThrow(
      ChangesetParseError,
    )
  })
})

describe('readChangesetDirectory', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-core-semver-'))
    await writeFile(join(dir, 'config.json'), '{}\n')
    await writeFile(join(dir, 'README.md'), '# changesets\n')
    await writeFile(join(dir, 'pre.json'), '{}\n')
    await writeFile(join(dir, 'breaking.md'), '---\n"@guren/server": major\n---\n\nx\n')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('reads the changesets and nothing else in the directory', async () => {
    const changesets = await readChangesetDirectory(dir)

    expect(changesets.map((c) => c.file)).toEqual(['breaking.md'])
  })

  test('throws rather than reporting an empty plan for a directory it cannot read', async () => {
    // The fail-open this replaces returned `[]`, which auditReleasePlan reads as
    // "no pending changesets" and reports at exit 0 — the gate announcing its
    // own breakage as a clean release.
    const missing = join(dir, 'not-here')

    await expect(readChangesetDirectory(missing)).rejects.toThrow(/no release plan to judge/)
    expect(auditReleasePlan(await readChangesetDirectory(dir))).toMatchObject({ code: 1 })
  })
})

describe('auditReleasePlan', () => {
  test('passes an empty release plan', () => {
    expect(auditReleasePlan([]).code).toBe(0)
  })

  test('passes when no changeset majors the server', () => {
    const plan = [
      changeset('a.md', '"@guren/server": minor'),
      changeset('b.md', '"@guren/orm": major'),
    ]

    expect(auditReleasePlan(plan).code).toBe(0)
  })

  test('passes when the core major is declared in a separate changeset', () => {
    const plan = [
      changeset('a.md', '"@guren/server": major'),
      changeset('b.md', '"@guren/core": major'),
    ]

    expect(auditReleasePlan(plan).code).toBe(0)
  })

  test('fails a server major with no core bump at all', () => {
    const result = auditReleasePlan([changeset('a.md', '"@guren/server": major')])

    expect(result.code).toBe(1)
    expect(result.messages[0]).toContain('not bumped at all')
    expect(result.messages.join('\n')).toContain('a.md')
  })

  test('fails a server major that bumps core by anything short of major', () => {
    // The shape that actually shipped: server 2.0.0 carried RFC 0006's removals
    // out through core 1.5.0, a minor, and `^1.4.0` delivered them.
    const result = auditReleasePlan([
      changeset('a.md', '"@guren/server": major'),
      changeset('b.md', '"@guren/core": minor'),
    ])

    expect(result.code).toBe(1)
    expect(result.messages[0]).toContain('only bumped `minor`')
  })

  test('fails when server and core share a changeset that under-bumps core', () => {
    const result = auditReleasePlan([
      changeset('a.md', '"@guren/server": major', '"@guren/core": patch'),
    ])

    expect(result.code).toBe(1)
  })

  test('fails, and says so plainly, when core is deliberately held at none', () => {
    const result = auditReleasePlan([
      changeset('a.md', '"@guren/server": major', '"@guren/core": none'),
    ])

    expect(result.code).toBe(1)
    expect(result.messages[0]).toContain('explicitly held at `none`')
  })

  test('names the loudest core bump in the plan, not the first one read', () => {
    const result = auditReleasePlan([
      changeset('a.md', '"@guren/server": major'),
      changeset('b.md', '"@guren/core": patch'),
      changeset('c.md', '"@guren/core": minor'),
    ])

    expect(result.code).toBe(1)
    expect(result.messages[0]).toContain('only bumped `minor`')
  })

  test('a core major elsewhere in the plan does not excuse a different release', () => {
    // Guards the inverse reading of the rule: core majoring on its own is fine
    // and must not be reported as a violation.
    expect(auditReleasePlan([changeset('a.md', '"@guren/core": major')]).code).toBe(0)
  })
})
