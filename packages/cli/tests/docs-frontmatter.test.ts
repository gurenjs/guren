import { describe, expect, it } from 'bun:test'
import { parseDocFrontmatter } from '../src/docs-frontmatter'

describe('parseDocFrontmatter', () => {
  it('parses scalars, inline arrays, and block lists', () => {
    const parsed = parseDocFrontmatter(`---
type: adr
status: stable
entities: [User, Invoice]
related:
  - app/Models/Invoice.ts
  - modules/billing/**
stale_after: 2026-07-25
---

# Billing cycle
`)

    expect(parsed).not.toBeNull()
    expect(parsed!.data.type).toBe('adr')
    expect(parsed!.data.status).toBe('stable')
    expect(parsed!.data.entities).toEqual(['User', 'Invoice'])
    expect(parsed!.data.related).toEqual(['app/Models/Invoice.ts', 'modules/billing/**'])
    expect(parsed!.data.stale_after).toBe('2026-07-25')
    expect(parsed!.body).toContain('# Billing cycle')
  })

  it('strips quotes from values', () => {
    const parsed = parseDocFrontmatter(`---
type: "adr"
entities: ['User']
---
body`)

    expect(parsed!.data.type).toBe('adr')
    expect(parsed!.data.entities).toEqual(['User'])
  })

  it('strips inline YAML comments from unquoted values', () => {
    const parsed = parseDocFrontmatter(`---
status: deprecated # replaced by 0009
entities: [Post] # main entity
related:
  - app/Models/Post.ts # the model
---
`)

    expect(parsed!.data.status).toBe('deprecated')
    expect(parsed!.data.entities).toEqual(['Post'])
    expect(parsed!.data.related).toEqual(['app/Models/Post.ts'])
  })

  it('respects quoted commas inside inline arrays', () => {
    const parsed = parseDocFrontmatter(`---
related: ["config/foo,bar.json", app/Models/Post.ts]
---
`)

    expect(parsed!.data.related).toEqual(['config/foo,bar.json', 'app/Models/Post.ts'])
  })

  it('parses block mappings for the OKF trust families', () => {
    const parsed = parseDocFrontmatter(`---
type: adr
generated:
  by: process:builder
  at: 2026-07-30T09:00:00Z
verified:
  by: human:ada
  at: 2026-07-30T10:00:00Z
---
body`)

    expect(parsed!.data.generated).toEqual({ by: 'process:builder', at: '2026-07-30T09:00:00Z' })
    expect(parsed!.data.verified).toEqual({ by: 'human:ada', at: '2026-07-30T10:00:00Z' })
  })

  it('parses a block list of inline mappings', () => {
    const parsed = parseDocFrontmatter(`---
verified:
  - { by: human:ada, at: T1 }
  - { by: process:nightly, at: T2 }
---
body`)

    expect(parsed!.data.verified).toEqual([
      { by: 'human:ada', at: 'T1' },
      { by: 'process:nightly', at: 'T2' },
    ])
  })

  it('parses a block list of block mappings', () => {
    const parsed = parseDocFrontmatter(`---
verified:
  - by: human:ada
    at: T1
  - by: process:nightly
    at: T2
status: stable
---
body`)

    expect(parsed!.data.verified).toEqual([
      { by: 'human:ada', at: 'T1' },
      { by: 'process:nightly', at: 'T2' },
    ])
    // The key after the block must stay top-level.
    expect(parsed!.data.status).toBe('stable')
  })

  it('parses an inline sequence of mappings', () => {
    const parsed = parseDocFrontmatter(`---
verified: [{ by: human:ada, at: T1 }, { by: process:nightly, at: T2 }]
---
body`)

    expect(parsed!.data.verified).toEqual([
      { by: 'human:ada', at: 'T1' },
      { by: 'process:nightly', at: 'T2' },
    ])
  })

  it('keeps a block mapping open across a comment line', () => {
    const parsed = parseDocFrontmatter(`---
generated:
  by: process:builder
  # who ran it
  at: T1
status: stable
---
body`)

    expect(parsed!.data.generated).toEqual({ by: 'process:builder', at: 'T1' })
    expect(parsed!.data.status).toBe('stable')
  })

  it('parses dash-only list items whose mapping starts on the next line', () => {
    const parsed = parseDocFrontmatter(`---
verified:
  -
    by: human:ada
    at: T1
  -
    by: human:bob
    at: T2
status: stable
---
body`)

    expect(parsed!.data.verified).toEqual([
      { by: 'human:ada', at: 'T1' },
      { by: 'human:bob', at: 'T2' },
    ])
    expect(parsed!.data.status).toBe('stable')
  })

  it('keeps a # that sits inside a nested quoted scalar', () => {
    const inArray = parseDocFrontmatter('---\ntags: ["C # language", docs]\n---\nbody')
    expect(inArray!.data.tags).toEqual(['C # language', 'docs'])

    const inMapping = parseDocFrontmatter('---\nverified: { by: "human:ada #1", at: T1 }\n---\nbody')
    expect(inMapping!.data.verified).toEqual({ by: 'human:ada #1', at: 'T1' })

    const inItem = parseDocFrontmatter(`---
verified:
  - by: "human:ada #1"
    at: T1
---
body`)
    expect(inItem!.data.verified).toEqual([{ by: 'human:ada #1', at: 'T1' }])
  })

  it('unescapes quotes inside quoted scalars', () => {
    const parsed = parseDocFrontmatter(`---
title: "He said \\"hello\\"" # a note
other: 'Ada''s guide'
---
body`)

    expect(parsed!.data.title).toBe('He said "hello"')
    expect(parsed!.data.other).toBe("Ada's guide")
  })

  it('strips comments that follow a quoted scalar', () => {
    const parsed = parseDocFrontmatter(`---
type: "adr" # architectural decision
status: "" # TODO
---
body`)

    expect(parsed!.data.type).toBe('adr')
    // An empty quoted scalar is empty, not the comment text — otherwise a
    // doc with no real type would satisfy the required-field check.
    expect(parsed!.data.status).toBe('')
  })

  it('returns null when there is no frontmatter', () => {
    expect(parseDocFrontmatter('# Just a heading\n')).toBeNull()
  })

  it('ignores unknown keys and malformed lines without failing', () => {
    const parsed = parseDocFrontmatter(`---
custom_field: hello
:::garbage:::
entities: []
---
`)

    expect(parsed!.data.custom_field).toBe('hello')
    expect(parsed!.data.entities).toEqual([])
  })
})
