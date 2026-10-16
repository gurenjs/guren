import { describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'

// Skills ship verbatim, so a frontmatter a strict loader cannot parse is skipped by every client with no error here.
const SKILLS_DIR = new URL('../templates/agent/core/skills/', import.meta.url)

const skills = (await readdir(SKILLS_DIR, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

describe('shipped skill frontmatter', () => {
  for (const skill of skills) {
    it(`${skill} parses as YAML and names its own directory`, async () => {
      const text = await readFile(new URL(`${skill}/SKILL.md`, SKILLS_DIR), 'utf8')
      const block = /^---\n([\s\S]*?)\n---\n/u.exec(text)
      expect(block).not.toBeNull()
      const frontmatter = Bun.YAML.parse(block![1]!) as { name?: unknown; description?: unknown }
      expect(frontmatter.name).toBe(skill)
      expect(typeof frontmatter.description).toBe('string')
    })
  }
})
