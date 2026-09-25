import { describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { RETIRED_CANONICAL_SKILLS } from '../src/agent-targets'

// `agent:sync --prune` claims every skill directory the harness ships; these three
// sentences spell that set out by hand, and `plan-implement` (#1060) shipped missing from all of them.
const SKILLS_DIR = new URL('../templates/agent/core/skills/', import.meta.url)

const LISTS = [
  { file: '../../../docs/en/guides/cli.md', start: 'its name is not one the harness itself ships:', end: ' for skills' },
  { file: '../../../docs/ja/guides/cli.md', start: 'スキルなら ', end: '、ルールなら' },
  { file: '../templates/agent-catalog/skills/guren-harness/SKILL.md', start: 'canonical skill names (', end: ')' },
]

async function shippedSkillNames(): Promise<string[]> {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
}

function listedSkillNames(text: string, file: string, start: string, end: string): string[] {
  const from = text.indexOf(start)
  const to = from === -1 ? -1 : text.indexOf(end, from + start.length)
  if (from === -1 || to === -1) {
    throw new Error(`${file}: the skill-name list between "${start}" and "${end}" is gone; update LISTS to the reworded sentence`)
  }
  const span = text.slice(from + start.length, to)
  return [...span.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).sort()
}

describe('documented harness skill names', () => {
  it('has no retired skill, which each list would also have to name', () => {
    expect(RETIRED_CANONICAL_SKILLS).toEqual([])
  })

  for (const { file, start, end } of LISTS) {
    it(`${file.replace(/^(\.\.\/)+/, '')} names exactly the shipped skill directories`, async () => {
      const text = await readFile(new URL(file, import.meta.url), 'utf8')
      expect(listedSkillNames(text, file, start, end)).toEqual(await shippedSkillNames())
    })
  }
})
