import { describe, it, expect } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocFrontmatter } from '../src/docs-frontmatter'

// `paths` is the only key Claude Code reads from a `.claude/rules/*.md` file; any other key
// is ignored without an error, and a rule with no `paths` loads into every session.
// https://code.claude.com/docs/en/memory#rule-frontmatter-reference
const RULES_DIR = join(import.meta.dir, '../templates/agent/core/rules')

async function readRules(): Promise<Array<[name: string, content: string]>> {
  const names = (await readdir(RULES_DIR)).filter((name) => name.endsWith('.md')).sort()
  return Promise.all(
    names.map(async (name): Promise<[string, string]> => [name, await readFile(join(RULES_DIR, name), 'utf8')]),
  )
}

/** Top-level keys read off the raw block: the frontmatter parser drops what it does not recognize. */
function rawFrontmatterKeys(content: string): string[] | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(content)?.[1]
  if (block === undefined) return null
  return block
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '' && !/^\s/u.test(line) && !line.startsWith('#'))
    .map((line) => line.split(':')[0].trim())
}

describe('agent harness rule templates', () => {
  it('ships at least one rule', async () => {
    expect((await readRules()).length).toBeGreaterThan(0)
  })

  it('declares `paths` and no other frontmatter key in every rule', async () => {
    for (const [name, content] of await readRules()) {
      expect({ name, keys: rawFrontmatterKeys(content) }).toEqual({ name, keys: ['paths'] })
    }
  })

  it('gives every rule a non-empty `paths` list of project-relative patterns', async () => {
    for (const [name, content] of await readRules()) {
      const paths = parseDocFrontmatter(content)?.data.paths
      expect({ name, isList: Array.isArray(paths) }).toEqual({ name, isList: true })
      const patterns = paths as unknown[]
      expect({ name, count: patterns.length > 0 }).toEqual({ name, count: true })
      for (const pattern of patterns) {
        expect({ name, pattern, ok: typeof pattern === 'string' && pattern !== '' }).toEqual({
          name,
          pattern,
          ok: true,
        })
        expect({ name, pattern, relative: !/^(?:\/|\.\/|\.\.\/)/u.test(String(pattern)) }).toEqual({
          name,
          pattern,
          relative: true,
        })
      }
    }
  })
})
