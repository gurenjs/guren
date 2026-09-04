import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { makeAdr } from '../src/make-adr'
import { parseDocFrontmatter } from '../src/docs-index'

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
      const result = await makeAdr('Billing cycle is end-of-month', { by: 'test-agent/1.0' })
      const content = readFileSync(result, 'utf8')

      expect(content.startsWith('---\n')).toBe(true)
      expect(content).toContain('type: adr')
      expect(content).toContain('status: draft')
      expect(content).toContain('entities: []')
      expect(content).toContain('related: []')
      expect(content).toMatch(
        /^generated: \{ by: "test-agent\/1\.0", at: \d{4}-\d{2}-\d{2}T[0-9:.]+Z \}$/m,
      )
      expect(content).toContain('# Billing cycle is end-of-month')
      expect(content).toContain('## Context')
      expect(content).toContain('## Decision')
      expect(content).toContain('## Consequences')
      expect(content.endsWith('\n')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects --by actors that could break out of the frontmatter', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-actor-')
    try {
      await expect(makeAdr('Actor injection', { by: 'x }\nstatus: stable' })).rejects.toThrow(
        'Invalid actor',
      )
      await expect(makeAdr('Quote injection', { by: 'x", at: y' })).rejects.toThrow('Invalid actor')
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts non-ASCII actors - git authors are not ASCII', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-unicode-')
    try {
      const file = await makeAdr('Unicode actor', { by: 'human:\u5c71\u7530\u592a\u90ce' })
      const parsed = parseDocFrontmatter(readFileSync(file, 'utf8'))

      expect((parsed!.data.generated as Record<string, string>).by).toBe('human:\u5c71\u7530\u592a\u90ce')
    } finally {
      await workspace.cleanup()
    }
  })

  // A git author like "Ada: Admin" produces an actor containing ': ',
  // which an unquoted YAML flow mapping cannot carry.
  it('quotes the actor so names containing colons stay parseable', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-colon-')
    try {
      const file = await makeAdr('Colon actor', { by: 'human:Ada: Admin' })
      const content = readFileSync(file, 'utf8')

      expect(content).toContain('generated: { by: "human:Ada: Admin", at: ')
      const parsed = parseDocFrontmatter(content)
      expect((parsed!.data.generated as Record<string, string>).by).toBe('human:Ada: Admin')
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

  // The sequence is always `max(existing) + 1` (counting `.MD` too), so a
  // repeated title is additive and `--force` has nothing to overwrite.
  it('never overwrites an existing ADR: a repeated title takes the next number', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-repeat-')
    try {
      const first = await makeAdr('Billing cycle')
      const second = await makeAdr('Billing cycle')

      expect(first).toContain('docs/adr/0001-billing-cycle.md')
      expect(second).toContain('docs/adr/0002-billing-cycle.md')
      expect(existsSync(first)).toBe(true)
      expect(readFileSync(first, 'utf8')).toContain('type: adr')
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

  it('prefills entities and related from a resolved --entity', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-entity-')
    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Resources'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        'export class PostController {}\n',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Http/Resources/PostResource.ts'),
        'export class PostResource {}\n',
        'utf8',
      )

      const result = await makeAdr('Posts are public', { entity: 'post' })
      const content = readFileSync(result, 'utf8')

      expect(content).toContain('entities: [Post]')
      expect(content).toContain('related:\n  - app/Http/Controllers/PostController.ts\n  - app/Http/Resources/PostResource.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefills an unknown --entity as given, with empty related', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-ghost-')
    try {
      const result = await makeAdr('Future decision', { entity: 'Ghost' })
      const content = readFileSync(result, 'utf8')

      expect(content).toContain('entities: [Ghost]')
      expect(content).toContain('related: []')
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects --entity values that are not plain identifiers', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-inject-')
    try {
      await expect(
        makeAdr('Injection attempt', { entity: 'Ghost]\nstatus: stable\nentities: [Post' }),
      ).rejects.toThrow('Invalid entity name')
      await expect(makeAdr('Injection attempt', { entity: 'Post # comment' })).rejects.toThrow(
        'Invalid entity name',
      )
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves name ties by ADR location and scopes companions to it', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-dup-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'app/Models'), { recursive: true })
      await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
      await mkdir(join(dir, 'modules/billing/app/Models'), { recursive: true })
      await mkdir(join(dir, 'modules/billing/app/Http/Controllers'), { recursive: true })
      await writeFile(join(dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
      await writeFile(
        join(dir, 'app/Http/Controllers/PostController.ts'),
        'export class PostController {}\n',
        'utf8',
      )
      await writeFile(
        join(dir, 'modules/billing/app/Models/Post.ts'),
        'export class Post {}\n',
        'utf8',
      )
      await writeFile(
        join(dir, 'modules/billing/app/Http/Controllers/PostController.ts'),
        'export class PostController {}\n',
        'utf8',
      )

      const rootAdr = await makeAdr('Root decision', { entity: 'Post' })
      const rootContent = readFileSync(rootAdr, 'utf8')
      expect(rootContent).toContain('- app/Http/Controllers/PostController.ts')
      expect(rootContent).not.toContain('modules/billing')

      const moduleAdr = await makeAdr('Billing decision', { entity: 'Post', root: 'billing' })
      const moduleContent = readFileSync(moduleAdr, 'utf8')
      expect(moduleContent).toContain('- modules/billing/app/Http/Controllers/PostController.ts')
      expect(moduleContent).not.toContain('- app/Http/Controllers/PostController.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('errors on a name tie that no location preference resolves', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-adr-ambiguous-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'modules/billing/app/Models'), { recursive: true })
      await mkdir(join(dir, 'modules/sales/app/Models'), { recursive: true })
      await writeFile(
        join(dir, 'modules/billing/app/Models/Post.ts'),
        'export class Post {}\n',
        'utf8',
      )
      await writeFile(
        join(dir, 'modules/sales/app/Models/Post.ts'),
        'export class Post {}\n',
        'utf8',
      )

      await expect(makeAdr('Ambiguous decision', { entity: 'Post' })).rejects.toThrow(
        'multiple locations: billing, sales',
      )
    } finally {
      await workspace.cleanup()
    }
  })
})
