import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { listSkills, loadSkills, readSkillResource } from '../../plugin-mcp/src/skills'
import { runCodegen } from '../src/codegen'
import { discoverMcpSkills, generateMcpSkills, MCP_SKILLS_MODULE, readMcpSkills, renderMcpSkillsModule } from '../src/mcp-skills'

const skillMd = (name: string, description = 'A skill.'): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

const EMPTY_MODULE = renderMcpSkillsModule({ files: {}, binary: {} })

describe('MCP skills codegen', () => {
  let app: string

  beforeEach(async () => {
    app = await mkdtemp(join(tmpdir(), 'guren-mcp-skills-'))
  })

  afterEach(async () => {
    await rm(app, { recursive: true, force: true })
  })

  async function put(path: string, contents: string | Uint8Array): Promise<void> {
    const file = join(app, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
  }

  const generate = () => generateMcpSkills({ appRoot: app, force: true })
  const generated = () => readFile(join(app, MCP_SKILLS_MODULE), 'utf8')

  describe('discoverMcpSkills', () => {
    test('should find root skills and module skills, the module name as the path prefix', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/refunds/references/policy.md', '# Policy\n')
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning'))

      const skills = await discoverMcpSkills(app)

      expect(skills.map(({ name, module, path }) => ({ name, module, path }))).toEqual([
        { name: 'refunds', module: null, path: 'refunds' },
        { name: 'dunning', module: 'billing', path: 'billing/dunning' },
      ])
      expect(skills[0]!.files.map((file) => file.key)).toEqual(['refunds/SKILL.md', 'refunds/references/policy.md'])
    })

    test('should leave out a directory with no top-level SKILL.md and a file beside the skill directories', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/loose/readme.md', 'not a skill')
      await put('resources/skills/group/nested/SKILL.md', skillMd('nested'))
      await put('resources/skills/README.md', 'about this directory')

      expect((await discoverMcpSkills(app)).map((skill) => skill.path)).toEqual(['refunds'])
    })

    test('should leave out dotfiles, dot directories and symlinks', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/refunds/.DS_Store', 'junk')
      await put('resources/skills/refunds/.cache/state.json', '{}')
      await put('secret.txt', 'not for publishing')
      await symlink(join(app, 'secret.txt'), join(app, 'resources/skills/refunds/secret.txt'))

      const [skill] = await discoverMcpSkills(app)

      expect(skill!.files.map((file) => file.key)).toEqual(['refunds/SKILL.md'])
    })

    test('should return nothing for an app with no skills directory', async () => {
      expect(await discoverMcpSkills(app)).toEqual([])
    })
  })

  describe('readMcpSkills', () => {
    test('should hold UTF-8 files as text and any other file as base64', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/refunds/assets/logo.bin', new Uint8Array([0xff, 0xfe, 0x00]))
      await put('resources/skills/refunds/bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))

      const content = await readMcpSkills(app)

      expect(content.files).toEqual({ 'refunds/SKILL.md': skillMd('refunds'), 'refunds/bom.txt': '﻿hi' })
      expect(content.binary).toEqual({ 'refunds/assets/logo.bin': '//4A' })
      expect(content.warnings).toEqual([])
    })

    test('should publish a path two skills give once, the root skill\'s, and say which file it dropped', async () => {
      await put('resources/skills/billing/SKILL.md', skillMd('billing'))
      await put('resources/skills/billing/dunning/SKILL.md', 'the root copy')
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning'))

      const content = await readMcpSkills(app)

      expect(content.files['billing/dunning/SKILL.md']).toBe('the root copy')
      expect(content.warnings).toHaveLength(1)
      expect(content.warnings[0]).toContain('modules/billing/resources/skills/dunning/SKILL.md is not published')
      expect(content.warnings[0]).toContain('resources/skills/billing/dunning/SKILL.md already takes skill://billing/dunning/SKILL.md')
    })
  })

  describe('renderMcpSkillsModule', () => {
    test('should render both exports, empty objects included', () => {
      expect(EMPTY_MODULE).toContain('export const files: Readonly<Record<string, string>> = {}\n')
      expect(EMPTY_MODULE).toContain('export const binary: Readonly<Record<string, string>> = {}\n')
    })
  })

  describe('generateMcpSkills', () => {
    test('should write nothing for an app that never had a skill', async () => {
      const result = await generate()

      expect(result).toEqual({ outputPath: null, skillCount: 0, warnings: [] })
      expect(await Bun.file(join(app, MCP_SKILLS_MODULE)).exists()).toBe(false)
    })

    test('should write the same bytes whatever order the files were created in', async () => {
      await put('resources/skills/zeta/SKILL.md', skillMd('zeta'))
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning'))
      await put('resources/skills/alpha/SKILL.md', skillMd('alpha'))
      await put('resources/skills/alpha/b.md', 'b')
      await put('resources/skills/alpha/a.md', 'a')

      const result = await generate()
      const source = await generated()

      expect(result.skillCount).toBe(3)
      const keys = [...source.matchAll(/^ {2}"([^"]+)": /gmu)].map((match) => match[1])
      expect(keys).toEqual(['alpha/SKILL.md', 'alpha/a.md', 'alpha/b.md', 'billing/dunning/SKILL.md', 'zeta/SKILL.md'])
    })

    test('should rewrite the module empty, never delete it, once the last skill is gone', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await generate()
      await rm(join(app, 'resources'), { recursive: true })

      const result = await generate()

      expect(result.outputPath).toBe(join(app, MCP_SKILLS_MODULE))
      expect(result.skillCount).toBe(0)
      expect(await generated()).toBe(EMPTY_MODULE)
    })

    test('should be written by the full codegen run, in an app with no routes file too', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))

      const stages = []
      for await (const stage of runCodegen({ appRoot: app })) stages.push(stage)

      const supporting = stages.find((stage) => stage.stage === 'supporting')
      expect(supporting).toMatchObject({ skillsOutputPath: join(app, MCP_SKILLS_MODULE), skillCount: 1, skillWarnings: [] })
      expect(await generated()).toContain('"refunds/SKILL.md"')
    })
  })

  describe('the generated module, loaded by the plugin', () => {
    test('should serve every published file with the bytes on disk', async () => {
      const logo = new Uint8Array([0xff, 0xfe, 0x00])
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds', 'Process refunds, 返金.'))
      await put('resources/skills/refunds/references/q&a 返金.md', 'q\n')
      await put('resources/skills/refunds/assets/logo.bin', logo)
      await put('resources/skills/refunds/.DS_Store', 'junk')
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning'))
      const { outputPath } = await generate()

      const skills = await loadSkills({ files: () => import(outputPath!) })

      const listed = listSkills(skills!, undefined).skills
      expect(listed.map((skill) => skill.uri)).toEqual(['skill://billing/dunning/SKILL.md', 'skill://refunds/SKILL.md'])
      expect(listed[1]!.frontmatter).toMatchObject({ name: 'refunds', description: 'Process refunds, 返金.' })
      expect(listed[1]!.resources).toMatchObject([
        { uri: 'skill://refunds/SKILL.md' },
        { uri: 'skill://refunds/assets/logo.bin' },
        { uri: 'skill://refunds/references/q&a%20%E8%BF%94%E9%87%91.md' },
      ])
      expect(readSkillResource('skill://refunds/SKILL.md', skills!)).toMatchObject({ text: skillMd('refunds', 'Process refunds, 返金.') })
      expect(readSkillResource('skill://refunds/assets/logo.bin', skills!)).toMatchObject({ blob: Buffer.from(logo).toString('base64') })
      expect(readSkillResource('skill://refunds/references/q&a%20%E8%BF%94%E9%87%91.md', skills!)).toMatchObject({ text: 'q\n' })
      expect(readSkillResource('skill://refunds/.DS_Store', skills!)).toBeUndefined()
    })

    test('should load as a catalog with no skills once rewritten empty', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await generate()
      await rm(join(app, 'resources'), { recursive: true })
      const { outputPath } = await generate()

      expect(await loadSkills({ files: () => import(outputPath!) })).toBeUndefined()
    })
  })
})
