import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { listSkills, loadSkills } from '../../plugin-mcp/src/skills'
import { makeMcpSkill, MCP_SKILL_DESCRIPTION_PLACEHOLDER, mcpSkillFile, mcpSkillServingHint } from '../src/make-mcp-skill'
import { generateMcpSkills, MCP_SKILLS_OPTION } from '../src/mcp-skills'

describe('make:mcp-skill', () => {
  let app: string

  beforeEach(async () => {
    app = await mkdtemp(join(tmpdir(), 'guren-make-mcp-skill-'))
  })

  afterEach(async () => {
    await rm(app, { recursive: true, force: true })
  })

  async function put(path: string, contents: string): Promise<void> {
    const file = join(app, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
  }

  async function servedFrontmatter(): Promise<unknown[]> {
    const { outputPath } = await generateMcpSkills({ appRoot: app, force: true })
    const skills = await loadSkills({ files: () => import(outputPath!) })
    return listSkills(skills!, undefined).skills.map((skill) => skill.frontmatter)
  }

  describe('mcpSkillFile', () => {
    test('should place a root skill under resources/skills and a module skill under the module', () => {
      expect(mcpSkillFile('refunds').path).toBe('resources/skills/refunds/SKILL.md')
      expect(mcpSkillFile('dunning', { root: 'Billing' }).path).toBe('modules/billing/resources/skills/dunning/SKILL.md')
    })

    test('should write the name and a placeholder description when none is given', () => {
      const { contents } = mcpSkillFile('refund-policy')

      expect(contents).toStartWith(`---\nname: "refund-policy"\ndescription: ${JSON.stringify(MCP_SKILL_DESCRIPTION_PLACEHOLDER)}\n---\n`)
      expect(contents).toContain('\n# Refund policy\n')
    })

    test.each(['Refunds', 'refund_policy', 'a--b', '-a', 'a-', '../x', 'a/b', '', 'a'.repeat(65)])('should refuse the name %p', (name) => {
      expect(() => mcpSkillFile(name)).toThrow('Invalid skill name')
    })

    test('should accept a name of 64 characters', () => {
      expect(mcpSkillFile('a'.repeat(64)).path).toBe(`resources/skills/${'a'.repeat(64)}/SKILL.md`)
    })

    test.each([
      ['', '1-1024 characters'],
      ['x'.repeat(1025), '1-1024 characters'],
      ['one\ntwo', 'one line of text'],
      ['one two', 'one line of text'],
      ['tab\there', 'one line of text'],
      ['c1\u0090control', 'one line of text'],
      ['lone\ud800surrogate', 'one line of text'],
    ])('should refuse the description %p', (description, reason) => {
      expect(() => mcpSkillFile('refunds', { description })).toThrow(reason)
    })

    test('should count a description in characters, so 1024 outside the basic plane fit', () => {
      expect(() => mcpSkillFile('refunds', { description: '😀'.repeat(1024) })).not.toThrow()
      expect(() => mcpSkillFile('refunds', { description: '😀'.repeat(1025) })).toThrow('1-1024 characters')
    })
  })

  describe('makeMcpSkill', () => {
    test('should refuse to replace a skill that exists, and replace it under force', async () => {
      const file = await makeMcpSkill('refunds', { cwd: app, description: 'First.' })
      expect(file).toBe(join(app, 'resources/skills/refunds/SKILL.md'))

      await expect(makeMcpSkill('refunds', { cwd: app, description: 'Second.' })).rejects.toThrow('already exists')
      expect(await readFile(file, 'utf8')).toContain('description: "First."')

      await makeMcpSkill('refunds', { cwd: app, description: 'Second.', force: true })
      expect(await readFile(file, 'utf8')).toContain('description: "Second."')
    })

    test('should write a description the endpoint reads back as given, quotes, colon, hash and backslash included', async () => {
      const description = 'Decide "refunds": policy #1, 返金 \\ end'
      await makeMcpSkill('refund-policy', { cwd: app, description })
      await makeMcpSkill('dunning', { cwd: app, root: 'billing' })

      expect(await servedFrontmatter()).toEqual([
        { name: 'dunning', description: MCP_SKILL_DESCRIPTION_PLACEHOLDER },
        { name: 'refund-policy', description },
      ])
    })

    test('should write a name YAML would read as another type so that the endpoint still serves the skill', async () => {
      for (const name of ['123', '1e3', 'no', 'null', 'true']) await makeMcpSkill(name, { cwd: app, description: 'Named like a YAML value.' })

      expect(await servedFrontmatter()).toEqual(['123', '1e3', 'no', 'null', 'true'].map((name) => ({ name, description: 'Named like a YAML value.' })))
    })

    test('should write only the skill when the description names a UI token class', async () => {
      await makeMcpSkill('theming', { cwd: app, description: 'Explain bg-g-panel and var(--g-line).' })

      expect(await Bun.file(join(app, 'resources/css/guren.css')).exists()).toBe(false)
    })
  })

  describe('mcpSkillServingHint', () => {
    const config = (options: string, preamble = ''): string => `import { mcpPlugin } from '@guren/plugin-mcp'\n${preamble}export default mcpPlugin(${options})\n`

    test('should say the plugin serves skills when the app calls mcpPlugin() nowhere', async () => {
      const hint = await mcpSkillServingHint({ cwd: app })

      expect(hint).toContain('No mcpPlugin() call was found')
      expect(hint).toContain(MCP_SKILLS_OPTION)
    })

    test('should name the file whose mcpPlugin() call carries no skills', async () => {
      await put('config/mcp.ts', config('{ tokens: [] }'))

      expect(await mcpSkillServingHint({ cwd: app })).toBe(`Add \`${MCP_SKILLS_OPTION}\` to the mcpPlugin() call in config/mcp.ts to serve it.`)
    })

    test('should name no file when two files call mcpPlugin() without skills', async () => {
      await put('config/mcp.ts', config('{ tokens: [] }'))
      await put('src/app.ts', config('{}'))

      expect(await mcpSkillServingHint({ cwd: app })).toBe(`Add \`${MCP_SKILLS_OPTION}\` to the mcpPlugin() call your app registers to serve it.`)
    })

    test('should say nothing when the call already carries skills', async () => {
      await put('config/mcp.ts', config("{ skills: { files: () => import('@/.guren/mcp-skills.gen') } }"))

      expect(await mcpSkillServingHint({ cwd: app })).toBeUndefined()
    })

    test('should say nothing for a call it cannot read whole', async () => {
      await put('config/mcp.ts', config('{ ...shared }', 'const shared = {}\n'))

      expect(await mcpSkillServingHint({ cwd: app })).toBeUndefined()
    })

    test('should say nothing when a file that names mcpPlugin does not parse', async () => {
      await put('config/mcp.ts', "import { mcpPlugin } from '@guren/plugin-mcp'\nexport default mcpPlugin({ skills: \n")

      expect(await mcpSkillServingHint({ cwd: app })).toBeUndefined()
    })
  })
})
