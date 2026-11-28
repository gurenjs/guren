import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { listSkills, loadSkills, readSkillResource } from '../../plugin-mcp/src/skills'
import { runCodegen } from '../src/codegen'
import {
  discoverMcpSkills,
  generateMcpSkills,
  MCP_SKILLS_MODULE,
  nestedSkillManifests,
  readMcpSkills,
  renderMcpSkillsModule,
} from '../src/mcp-skills'

const skillMd = (name: string, description = 'A skill.'): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`

const EMPTY_MODULE = renderMcpSkillsModule({ files: {}, binary: {} })
const SKILLS_CONFIG = `import { mcpPlugin } from '@guren/plugin-mcp'

export default mcpPlugin({ skills: { files: () => import('@/.guren/mcp-skills.gen') } })
`

describe('MCP skills codegen', () => {
  let app: string

  beforeEach(async () => {
    app = await mkdtemp(join(tmpdir(), 'guren-mcp-skills-'))
  })

  afterEach(async () => {
    await rm(app, { recursive: true, force: true })
  })

  async function putIn(root: string, path: string, contents: string | Uint8Array): Promise<void> {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
  }

  const put = (path: string, contents: string | Uint8Array) => putIn(app, path, contents)
  const generate = (root = app) => generateMcpSkills({ appRoot: root, force: true })
  const generated = (root = app) => readFile(join(root, MCP_SKILLS_MODULE), 'utf8')

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

    test('should list modules by name, whatever order they were created in', async () => {
      await put('modules/zebra/resources/skills/stripes/SKILL.md', skillMd('stripes'))
      await put('modules/alpha/resources/skills/first/SKILL.md', skillMd('first'))

      expect((await discoverMcpSkills(app)).map((skill) => skill.path)).toEqual(['alpha/first', 'zebra/stripes'])
    })

    test('should leave out a directory with no top-level SKILL.md and a file beside the skill directories', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/loose/readme.md', 'not a skill')
      await put('resources/skills/group/nested/SKILL.md', skillMd('nested'))
      await put('resources/skills/README.md', 'about this directory')

      expect((await discoverMcpSkills(app)).map((skill) => skill.path)).toEqual(['refunds'])
    })

    test('should not take a directory named SKILL.md for a manifest', async () => {
      await put('resources/skills/refunds/SKILL.md/notes.md', 'a directory, not a manifest')

      expect(await discoverMcpSkills(app)).toEqual([])
    })

    test('should name a manifest spelled in another case, and not publish its directory', async () => {
      await put('resources/skills/refunds/skill.md', skillMd('refunds'))
      const warnings: string[] = []

      expect(await discoverMcpSkills(app, warnings)).toEqual([])
      expect(warnings).toEqual(["resources/skills/refunds/skill.md is not published: a skill's manifest is named SKILL.md, in that case."])
    })

    test('should leave out dotfiles, dot directories and symlinks inside a skill', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/refunds/.DS_Store', 'junk')
      await put('resources/skills/refunds/.cache/state.json', '{}')
      await put('secret.txt', 'not for publishing')
      await put('private/notes.md', 'not for publishing')
      await symlink(join(app, 'secret.txt'), join(app, 'resources/skills/refunds/secret.txt'))
      await symlink(join(app, 'private'), join(app, 'resources/skills/refunds/private'))

      const [skill] = await discoverMcpSkills(app)

      expect(skill!.files.map((file) => file.key)).toEqual(['refunds/SKILL.md'])
    })

    test('should not follow a symlink standing for a skill directory or for the skills directory', async () => {
      await put('elsewhere/refunds/SKILL.md', skillMd('refunds'))
      await mkdir(join(app, 'resources/skills'), { recursive: true })
      await symlink(join(app, 'elsewhere/refunds'), join(app, 'resources/skills/refunds'))
      await mkdir(join(app, 'modules/billing/resources'), { recursive: true })
      await symlink(join(app, 'elsewhere'), join(app, 'modules/billing/resources/skills'))

      expect(await discoverMcpSkills(app)).toEqual([])
    })

    test('should return nothing for an app with no skills directory', async () => {
      expect(await discoverMcpSkills(app)).toEqual([])
    })
  })

  describe('nestedSkillManifests', () => {
    test('should pair a manifest with the nearest skill it sits inside, and report nothing for siblings', () => {
      expect(nestedSkillManifests([
        'refunds/SKILL.md',
        'refunds/notes.md',
        'refunds-eu/SKILL.md',
        'billing/SKILL.md',
        'billing/dunning/SKILL.md',
        'billing/dunning/late/SKILL.md',
      ])).toEqual([
        { inner: 'billing/dunning/SKILL.md', outer: 'billing/SKILL.md' },
        { inner: 'billing/dunning/late/SKILL.md', outer: 'billing/dunning/SKILL.md' },
      ])
    })
  })

  describe('readMcpSkills', () => {
    test('should hold UTF-8 files as text and any other file as base64', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/refunds/assets/logo.bin', new Uint8Array([0xff, 0xfe, 0x00]))
      await put('resources/skills/refunds/bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))
      await put('resources/skills/refunds/empty.txt', '')

      const content = await readMcpSkills(app)

      expect(content.files).toEqual({ 'refunds/SKILL.md': skillMd('refunds'), 'refunds/bom.txt': '﻿hi', 'refunds/empty.txt': '' })
      expect(content.binary).toEqual({ 'refunds/assets/logo.bin': '//4A' })
      expect(content.warnings).toEqual([])
    })

    test('should warn that a root skill named after a module with skills will not boot, with both files', async () => {
      await put('resources/skills/billing/SKILL.md', skillMd('billing'))
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning'))

      const { warnings } = await readMcpSkills(app)

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toStartWith('modules/billing/resources/skills/dunning/SKILL.md sits inside the skill resources/skills/billing/SKILL.md')
      expect(warnings[0]).toContain('refuses a nested skill at boot')
    })

    test('should warn about a SKILL.md below another skill\'s directory', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/refunds/partial/SKILL.md', skillMd('partial'))

      const { warnings } = await readMcpSkills(app)

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toStartWith('resources/skills/refunds/partial/SKILL.md sits inside the skill resources/skills/refunds/SKILL.md')
    })

    test('should publish a path two skills give once, the root skill\'s, and say which file it dropped', async () => {
      await put('resources/skills/billing/SKILL.md', skillMd('billing'))
      await put('resources/skills/billing/dunning/SKILL.md', 'the root copy')
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning'))

      const content = await readMcpSkills(app)

      expect(content.files['billing/dunning/SKILL.md']).toBe('the root copy')
      expect(content.warnings).toEqual([
        'modules/billing/resources/skills/dunning/SKILL.md is not published: resources/skills/billing/dunning/SKILL.md already takes skill://billing/dunning/SKILL.md.',
        expect.stringContaining('resources/skills/billing/dunning/SKILL.md sits inside the skill resources/skills/billing/SKILL.md'),
      ])
    })
  })

  describe('renderMcpSkillsModule', () => {
    test('should render both exports, empty objects included', () => {
      expect(EMPTY_MODULE).toContain('export const files: Readonly<Record<string, string>> = {}\n')
      expect(EMPTY_MODULE).toContain('export const binary: Readonly<Record<string, string>> = {}\n')
    })
  })

  describe('generateMcpSkills', () => {
    test('should write nothing for an app that has no skill and never names the module', async () => {
      await put('package.json', JSON.stringify({ dependencies: { '@guren/plugin-mcp': '^0.8.0' } }))
      await put('config/mcp.ts', "import { mcpPlugin } from '@guren/plugin-mcp'\n\nexport default mcpPlugin()\n")

      const result = await generate()

      expect(result).toEqual({ outputPath: null, skillCount: 0, warnings: [] })
      expect(await Bun.file(join(app, MCP_SKILLS_MODULE)).exists()).toBe(false)
    })

    test('should write the module empty for an app that imports it and has no skill yet', async () => {
      await put('package.json', JSON.stringify({ dependencies: { '@guren/plugin-mcp': '^0.8.0' } }))
      await put('config/mcp.ts', SKILLS_CONFIG)

      const result = await generate()

      expect(result).toEqual({ outputPath: join(app, MCP_SKILLS_MODULE), skillCount: 0, warnings: [] })
      expect(await generated()).toBe(EMPTY_MODULE)
    })

    test('should write the same bytes for the same files, whatever order they were created in', async () => {
      const other = await mkdtemp(join(tmpdir(), 'guren-mcp-skills-other-'))
      try {
        const entries: Array<[string, string | Uint8Array]> = [
          ['resources/skills/zeta/SKILL.md', skillMd('zeta')],
          ['modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning')],
          ['resources/skills/alpha/SKILL.md', skillMd('alpha')],
          ['resources/skills/alpha/b.md', 'b'],
          ['resources/skills/alpha/a.md', 'a'],
          ['resources/skills/alpha/z.bin', new Uint8Array([0xff])],
          ['resources/skills/alpha/y.bin', new Uint8Array([0xfe])],
        ]
        for (const [path, contents] of entries) await put(path, contents)
        for (const [path, contents] of [...entries].reverse()) await putIn(other, path, contents)

        expect((await generate()).skillCount).toBe(3)
        await generate(other)
        const source = await generated()

        expect(await generated(other)).toBe(source)
        expect([...source.matchAll(/^ {2}"([^"]+)": /gmu)].map((match) => match[1])).toEqual([
          'alpha/SKILL.md', 'alpha/a.md', 'alpha/b.md', 'billing/dunning/SKILL.md', 'zeta/SKILL.md',
          'alpha/y.bin', 'alpha/z.bin',
        ])
      } finally {
        await rm(other, { recursive: true, force: true })
      }
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
      expect(await generated()).not.toContain('.DS_Store')

      const skills = await loadSkills({ files: () => import(outputPath!) })

      const listed = listSkills(skills!, undefined).skills
      expect(listed.map((skill) => skill.uri)).toEqual(['skill://billing/dunning/SKILL.md', 'skill://refunds/SKILL.md'])
      expect(listed[1]!.frontmatter).toMatchObject({ name: 'refunds', description: 'Process refunds, 返金.' })
      expect(listed[1]!.resources).toMatchObject([
        { uri: 'skill://refunds/SKILL.md' },
        { uri: 'skill://refunds/assets/logo.bin' },
        { uri: 'skill://refunds/references/q&a%20%E8%BF%94%E9%87%91.md' },
      ])
      expect(readSkillResource('skill://billing/dunning/SKILL.md', skills!)).toMatchObject({ text: skillMd('dunning') })
      expect(readSkillResource('skill://refunds/SKILL.md', skills!)).toMatchObject({ text: skillMd('refunds', 'Process refunds, 返金.') })
      expect(readSkillResource('skill://refunds/assets/logo.bin', skills!)).toMatchObject({ blob: Buffer.from(logo).toString('base64') })
      expect(readSkillResource('skill://refunds/references/q&a%20%E8%BF%94%E9%87%91.md', skills!)).toMatchObject({ text: 'q\n' })
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
