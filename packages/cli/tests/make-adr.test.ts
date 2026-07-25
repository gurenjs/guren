import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { makeAdr } from '../src/make-adr'

async function seedAdrFiles(dir: string, names: string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  for (const name of names) {
    await writeFile(join(dir, name), '# seeded\n', 'utf8')
  }
}

describe('makeAdr', () => {
  it('creates the first ADR at 0001 when docs/adr does not exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-first-')
    try {
      const result = await makeAdr('Billing cycle is end-of-month')

      expect(result).toContain('docs/adr/0001-billing-cycle-is-end-of-month.md')
      expect(existsSync(result)).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('fills in the frontmatter and section skeleton', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-template-')
    try {
      const result = await makeAdr('Billing cycle is end-of-month')
      const content = readFileSync(result, 'utf8')

      expect(content.startsWith('---\n')).toBe(true)
      expect(content).toContain('kind: adr')
      expect(content).toContain('status: draft')
      expect(content).toContain('entities: []')
      expect(content).toContain('related: []')
      expect(content).toMatch(/^last_reviewed: \d{4}-\d{2}-\d{2}$/m)
      expect(content).toContain('# Billing cycle is end-of-month')
      expect(content).toContain('## Context')
      expect(content).toContain('## Decision')
      expect(content).toContain('## Consequences')
      expect(content.endsWith('\n')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('continues the sequence after existing ADRs', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-sequence-')
    try {
      await seedAdrFiles(join(workspace.dir, 'docs/adr'), [
        '0001-first-decision.md',
        '0002-second-decision.md',
      ])

      const result = await makeAdr('Third decision')

      expect(result).toContain('docs/adr/0003-third-decision.md')
    } finally {
      await workspace.cleanup()
    }
  })

  it('uses the highest existing number, not the file count, and ignores non-ADR files', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-gap-')
    try {
      await seedAdrFiles(join(workspace.dir, 'docs/adr'), [
        '0001-first-decision.md',
        '0007-seventh-decision.md',
        'README.md',
        'notes.txt',
        '12-not-four-digits.md',
      ])

      const result = await makeAdr('Next decision')

      expect(result).toContain('docs/adr/0008-next-decision.md')
    } finally {
      await workspace.cleanup()
    }
  })

  it('slugifies punctuation, casing, and whitespace runs', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-slug-')
    try {
      const result = await makeAdr('  Use HTTP/2 — Why?  ')

      expect(result).toContain('docs/adr/0001-use-http-2-why.md')
      const content = readFileSync(result, 'utf8')
      expect(content).toContain('# Use HTTP/2 — Why?')
    } finally {
      await workspace.cleanup()
    }
  })

  it('falls back to an "adr" slug when the title has no ASCII alphanumerics', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-slug-fallback-')
    try {
      const result = await makeAdr('請求サイクル')

      expect(result).toContain('docs/adr/0001-adr.md')
      expect(existsSync(result)).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('writes into modules/<name>/docs/adr when a module root is given', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-module-')
    try {
      const result = await makeAdr('Invoice numbering', { root: 'Billing' })

      expect(result).toContain('modules/billing/docs/adr/0001-invoice-numbering.md')
      expect(existsSync(result)).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('numbers module ADRs independently of the project-root docs/adr', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-module-sequence-')
    try {
      await seedAdrFiles(join(workspace.dir, 'docs/adr'), ['0001-root-decision.md'])

      const result = await makeAdr('Module decision', { root: 'billing' })

      expect(result).toContain('modules/billing/docs/adr/0001-module-decision.md')
    } finally {
      await workspace.cleanup()
    }
  })

  it('counts uppercase .MD files so numbering cannot collide on a case-insensitive filesystem', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-case-')
    try {
      await seedAdrFiles(join(workspace.dir, 'docs/adr'), ['0001-Billing-Cycle.MD'])

      const result = await makeAdr('Billing cycle')

      expect(result).toContain('docs/adr/0002-billing-cycle.md')
      expect(existsSync(result)).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  // `writeFileSafe` refuses to overwrite without `--force`. Because the sequence
  // is always `max(existing) + 1` (counting `.MD` too), a repeated title is
  // additive rather than an error, so `--force` has nothing to overwrite here.
  it('never overwrites an existing ADR: a repeated title takes the next number', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-repeat-')
    try {
      const first = await makeAdr('Billing cycle')
      const second = await makeAdr('Billing cycle')

      expect(first).toContain('docs/adr/0001-billing-cycle.md')
      expect(second).toContain('docs/adr/0002-billing-cycle.md')
      expect(existsSync(first)).toBe(true)
      expect(readFileSync(first, 'utf8')).toContain('kind: adr')
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts the shared force writer option without altering numbering', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-force-')
    try {
      await seedAdrFiles(join(workspace.dir, 'docs/adr'), ['0001-billing-cycle.md'])

      const result = await makeAdr('Billing cycle', { force: true })

      expect(result).toContain('docs/adr/0002-billing-cycle.md')
      expect(readFileSync(join(workspace.dir, 'docs/adr/0001-billing-cycle.md'), 'utf8')).toBe('# seeded\n')
    } finally {
      await workspace.cleanup()
    }
  })
})
