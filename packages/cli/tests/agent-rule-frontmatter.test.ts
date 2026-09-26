import { describe, it, expect } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadAgentTemplates } from '../src/agent-harness'
import { planComponents } from '../src/agent-targets'

const RULES_DIR = join(import.meta.dir, '../templates/agent/core/rules')

/**
 * The whole block, not its keys: a block YAML rejects (an indented key, a tab, a `: ` value)
 * makes Claude Code drop the frontmatter and load the rule as if it had no `paths`.
 */
const PATHS_ONLY_FRONTMATTER = /^---\n(paths:\n(?: {2}- "[^"\\\n]+"\n)+)---\n/u

async function readRules(): Promise<Array<[name: string, content: string]>> {
  const names = (await readdir(RULES_DIR)).filter((name) => name.endsWith('.md')).sort()
  return Promise.all(
    names.map(async (name): Promise<[string, string]> => [name, await readFile(join(RULES_DIR, name), 'utf8')]),
  )
}

function frontmatter(content: string): unknown {
  const block = /^---\n([\s\S]*?)\n---\n/u.exec(content)?.[1]
  return block === undefined ? undefined : Bun.YAML.parse(block)
}

describe('agent harness rule templates', () => {
  it('ships at least one rule', async () => {
    expect((await readRules()).length).toBeGreaterThan(0)
  })

  // `paths` is the only key Claude Code reads from a `.claude/rules/*.md` file; any other key
  // is ignored without an error, and a rule with no `paths` loads into every session.
  // https://code.claude.com/docs/en/memory#rule-frontmatter-reference
  it('opens every rule with a `paths`-only block of quoted project-relative patterns', async () => {
    for (const [name, content] of await readRules()) {
      const block = PATHS_ONLY_FRONTMATTER.exec(content)?.[1]
      expect({ name, block: block !== undefined }).toEqual({ name, block: true })
      const { paths } = frontmatter(content) as { paths: string[] }
      for (const pattern of paths) {
        expect({ name, pattern, relative: !/^(?:\/|\.\.?\/)/u.test(pattern) }).toEqual({
          name,
          pattern,
          relative: true,
        })
      }
    }
  })

  it('renders Cursor and Copilot frontmatter that parses as YAML to the rule heading and patterns', async () => {
    const rules = await readRules()
    const planned = new Map(
      planComponents(['agents', 'cursor', 'copilot'], await loadAgentTemplates(), 'My App').map((file) => [
        file.path,
        file.content,
      ]),
    )
    for (const [name, content] of rules) {
      const stem = name.replace(/\.md$/u, '')
      const { paths } = frontmatter(content) as { paths: string[] }
      const heading = /^---\n[\s\S]*?\n---\n\s*# +(.+?)\s*$/mu.exec(content)?.[1]
      expect({ name, heading: typeof heading }).toEqual({ name, heading: 'string' })

      expect({ name, cursor: frontmatter(planned.get(`.cursor/rules/guren-${stem}.mdc`) ?? '') }).toEqual({
        name,
        cursor: { description: heading, globs: paths.join(','), alwaysApply: false },
      })
      expect({
        name,
        copilot: frontmatter(planned.get(`.github/instructions/guren-${stem}.instructions.md`) ?? ''),
      }).toEqual({ name, copilot: { description: heading, applyTo: paths.join(',') } })
    }
  })
})
