import { describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { RETIRED_CANONICAL_RULES, RETIRED_CANONICAL_SKILLS } from '../src/agent-targets'

// `agent:sync --prune` claims every skill directory and rule file the harness ships; these
// sentences spell both sets out by hand, and `plan-implement` (#1060) shipped missing from every skill list.
const SKILLS_DIR = new URL('../templates/agent/core/skills/', import.meta.url)
const RULES_DIR = new URL('../templates/agent/core/rules/', import.meta.url)

const SKILL_LISTS = [
  { file: '../../../docs/en/guides/agent-harness.md', start: '| `.claude/skills/`, `.agents/skills/` | ', end: ' |\n' },
  { file: '../../../docs/ja/guides/agent-harness.md', start: 'スキルなら ', end: '、ルールなら' },
  { file: '../templates/agent-catalog/skills/guren-harness/SKILL.md', start: 'canonical skill names (', end: ')' },
]

const RULE_LISTS = [
  { file: '../../../docs/en/tutorials/01-zero-to-deployed.md', start: 'for one area each (', end: ')' },
  { file: '../../../docs/ja/tutorials/01-zero-to-deployed.md', start: 'API ルールが入っています(', end: ')' },
  { file: '../templates/agent/core/rules-catalog.md', start: 'The rule files: ', end: 'Most end with' },
]

async function shippedSkillNames(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

async function shippedRuleNames(): Promise<string[]> {
  const entries = await readdir(RULES_DIR, { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name).sort()
}

function listedNames(text: string, file: string, start: string, end: string, name: RegExp): string[] {
  const from = text.indexOf(start)
  const to = from === -1 ? -1 : text.indexOf(end, from + start.length)
  if (from === -1 || to === -1) {
    throw new Error(`${file}: the name list between "${start}" and "${end}" is gone; update the list to the reworded sentence`)
  }
  const span = text.slice(from + start.length, to)
  return [...span.matchAll(name)].map((match) => match[1]!).sort()
}

const displayPath = (file: string) => file.replace(/^(\.\.\/)+/, '')

describe('documented harness skill names', () => {
  it('has no retired skill, which each list would also have to name', () => {
    expect(RETIRED_CANONICAL_SKILLS).toEqual([])
  })

  for (const { file, start, end } of SKILL_LISTS) {
    it(`${displayPath(file)} names exactly the shipped skill directories`, async () => {
      const text = await readFile(new URL(file, import.meta.url), 'utf8')
      expect(listedNames(text, file, start, end, /`([^`]+)`/g)).toEqual(await shippedSkillNames())
    })
  }
})

describe('documented harness rule names', () => {
  it('has no retired rule, which each list would also have to name', () => {
    expect(RETIRED_CANONICAL_RULES).toEqual([])
  })

  for (const { file, start, end } of RULE_LISTS) {
    it(`${displayPath(file)} names exactly the shipped rule files`, async () => {
      const text = await readFile(new URL(file, import.meta.url), 'utf8')
      expect(listedNames(text, file, start, end, /`([\w-]+\.md)`/g)).toEqual(await shippedRuleNames())
    })
  }
})
