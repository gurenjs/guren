import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { runAudit } from '../src/audit'
import { runCheck } from '../src/check'
import { commandFix, type CheckResult } from '../src/check-result'
import { generateMcpSkills, MCP_SKILLS_MODULE, readMcpSkills } from '../src/mcp-skills'
import { checkMcpSkills, HOST_SKILL_COUNT, loadMcpSkillCatalog, SKILL_FILE_LIMIT } from '../src/mcp-skills-check'
import { ParseCache } from '../src/parse-cache'
import { listSkills } from '../src/tool-list'

const skillMd = (name: string, description = 'A skill.'): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
const mcpConfig = (options: string, preamble = ''): string => `import { mcpPlugin } from '@guren/plugin-mcp'\n${preamble}export default mcpPlugin(${options})\n`
const SERVING = mcpConfig("{ skills: { files: () => import('@/.guren/mcp-skills.gen') } }")
const FIX = commandFix('codegen')

describe('MCP skills checks', () => {
  let app: string

  beforeEach(async () => {
    app = await mkdtemp(join(tmpdir(), 'guren-mcp-skills-check-'))
  })

  afterEach(async () => {
    await rm(app, { recursive: true, force: true })
  })

  async function put(path: string, contents: string | Uint8Array): Promise<void> {
    const file = join(app, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
  }

  const codegen = () => generateMcpSkills({ appRoot: app, force: true })
  const run = () => checkMcpSkills({ cwd: app, cache: new ParseCache(), fix: FIX })
  const byKey = (results: CheckResult[], key: string) => results.find((result) => result.key === key)

  /** A served, current app with one valid skill: every rule passes or is silent. */
  async function healthyApp(): Promise<void> {
    await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
    await put('config/mcp.ts', SERVING)
    await codegen()
  }

  describe('checkMcpSkills', () => {
    test('should say nothing for an app with no skills directory and no generated module', async () => {
      await put('config/mcp.ts', mcpConfig('{ tokens: [] }'))

      expect(await run()).toEqual([])
    })

    test('should pass the module and the serving rule, and report nothing else, for a healthy app', async () => {
      await healthyApp()

      const results = await run()

      expect(results.map(({ key, status }) => ({ key, status }))).toEqual([
        { key: 'mcp-skills-stale', status: 'pass' },
        { key: 'mcp-skills-unserved', status: 'pass' },
      ])
    })

    test('should fail a skill the catalog refuses, with the reason the endpoint would print', async () => {
      await healthyApp()
      await put('resources/skills/renamed/SKILL.md', skillMd('other'))
      await put('resources/skills/bare/SKILL.md', 'no frontmatter at all\n')
      await put('resources/skills/nameless/SKILL.md', '---\ndescription: d\n---\n')
      await codegen()

      const results = await run()

      expect(byKey(results, 'mcp-skill-frontmatter:resources/skills/renamed/SKILL.md')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('frontmatter name "other" must match the last path segment "renamed"'),
        filePath: 'resources/skills/renamed/SKILL.md',
      })
      expect(byKey(results, 'mcp-skill-frontmatter:resources/skills/bare/SKILL.md')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('must begin with a "---" line'),
      })
      expect(byKey(results, 'mcp-skill-frontmatter:resources/skills/nameless/SKILL.md')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('must contain string "name" and "description"'),
      })
      expect(results.some((result) => result.key === 'mcp-skill-frontmatter:resources/skills/refunds/SKILL.md')).toBe(false)
    })

    test('should fail a manifest in another case, a nested skill, and a root skill named after a module with skills', async () => {
      await healthyApp()
      await put('resources/skills/lower/skill.md', skillMd('lower'))
      await put('resources/skills/refunds/partial/SKILL.md', skillMd('partial'))
      await put('resources/skills/billing/SKILL.md', skillMd('billing'))
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('dunning'))

      const results = await run()

      expect(byKey(results, 'mcp-skill-manifest:resources/skills/lower/skill.md')).toMatchObject({ status: 'fail' })
      expect(byKey(results, 'mcp-skill-namespace:resources/skills/refunds/partial/SKILL.md')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('sits inside the skill resources/skills/refunds/SKILL.md'),
      })
      expect(byKey(results, 'mcp-skill-namespace:modules/billing/resources/skills/dunning/SKILL.md')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('sits inside the skill resources/skills/billing/SKILL.md'),
      })
    })

    test('should fail a skill past the file limit every host accepts, and leave one at the limit alone', async () => {
      await healthyApp()
      for (let index = 1; index < SKILL_FILE_LIMIT; index += 1) await put(`resources/skills/refunds/notes/${index}.md`, 'n')
      await codegen()
      expect((await run()).some((result) => result.key.startsWith('mcp-skill-limit'))).toBe(false)

      await put('resources/skills/refunds/notes/one-more.md', 'n')
      await codegen()

      expect(byKey(await run(), 'mcp-skill-limit:resources/skills/refunds/SKILL.md')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining(`holds ${SKILL_FILE_LIMIT + 1} files`),
      })
    })

    test('should give advice, never a gating result, past what a host documents', async () => {
      await healthyApp()
      await put('resources/skills/refunds/long.md', 'x'.repeat(100_001))
      await put('resources/skills/refunds/exact.md', 'x'.repeat(100_000))
      await put('resources/skills/refunds/assets/blob.bin', new Uint8Array(300_000).fill(0xff))
      await codegen()

      const results = await run()

      expect(byKey(results, 'mcp-skill-host-limit:resources/skills/refunds/long.md')).toMatchObject({ status: 'warn', advisory: true })
      expect(byKey(results, 'mcp-skill-host-limit:resources/skills/refunds/exact.md')).toBeUndefined()
      expect(byKey(results, 'mcp-skill-host-limit:resources/skills/refunds/assets/blob.bin')).toBeUndefined()
      expect(byKey(results, 'mcp-skill-host-limit:resources/skills/refunds/SKILL.md')).toMatchObject({ status: 'warn', advisory: true })
    })

    test('should advise on more skills than a host lists per server', async () => {
      await put('config/mcp.ts', SERVING)
      for (let index = 0; index <= HOST_SKILL_COUNT; index += 1) await put(`resources/skills/skill-${index}/SKILL.md`, skillMd(`skill-${index}`))
      await codegen()

      expect(byKey(await run(), 'mcp-skill-host-limit')).toMatchObject({
        status: 'warn',
        advisory: true,
        message: expect.stringContaining(`${HOST_SKILL_COUNT + 1} skills`),
      })
    })

    test('should fail a missing module and a module that differs, each with the codegen fix', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('config/mcp.ts', SERVING)

      expect(byKey(await run(), 'mcp-skills-stale')).toMatchObject({ status: 'fail', message: `${MCP_SKILLS_MODULE} is missing.`, fix: FIX })

      await codegen()
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds', 'Edited after codegen.'))

      expect(byKey(await run(), 'mcp-skills-stale')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining('differs from the skills it is generated from'),
        fix: FIX,
      })
    })

    test('should fail a module still holding skills that were deleted', async () => {
      await healthyApp()
      await rm(join(app, 'resources'), { recursive: true })

      const results = await run()

      expect(results.map(({ key, status }) => ({ key, status }))).toEqual([{ key: 'mcp-skills-stale', status: 'fail' }])
    })

    test('should fail a missing module for an app that imports it and has no skill', async () => {
      await put('package.json', JSON.stringify({ dependencies: { '@guren/plugin-mcp': '^0.8.0' } }))
      await put('config/mcp.ts', SERVING)

      expect((await run()).map(({ key, status, message }) => ({ key, status, message }))).toEqual([
        { key: 'mcp-skills-stale', status: 'fail', message: `${MCP_SKILLS_MODULE} is missing.` },
      ])
    })

    test('should warn when the mcpPlugin() call has no skills, naming its file', async () => {
      await healthyApp()
      await put('config/mcp.ts', mcpConfig('{ tokens: [] }'))

      expect(byKey(await run(), 'mcp-skills-unserved')).toMatchObject({
        status: 'warn',
        message: expect.stringContaining('the mcpPlugin() call in config/mcp.ts has no skills option'),
        filePath: 'config/mcp.ts',
      })
      expect(byKey(await run(), 'mcp-skills-unserved')?.advisory).toBeUndefined()
    })

    test('should warn when the app calls mcpPlugin() nowhere', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await codegen()

      expect(byKey(await run(), 'mcp-skills-unserved')).toMatchObject({ status: 'warn', message: expect.stringContaining('no mcpPlugin() call') })
    })

    test('should call serving unverified, never passed, for a call it cannot read whole', async () => {
      await healthyApp()
      await put('config/mcp.ts', mcpConfig('{ ...shared }', 'const shared = {}\n'))

      expect(byKey(await run(), 'mcp-skills-unserved')).toMatchObject({
        status: 'warn',
        advisory: true,
        message: expect.stringContaining('is unverified'),
      })
    })
  })

  describe('loadMcpSkillCatalog', () => {
    test('should list what the endpoint would serve and what it refused, by published key', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds', 'Process refunds.'))
      await put('resources/skills/refunds/references/policy.md', '# Policy\n')
      await put('modules/billing/resources/skills/dunning/SKILL.md', skillMd('wrong'))

      const catalog = await loadMcpSkillCatalog(await readMcpSkills(app))

      expect(catalog.skills).toEqual([
        { uri: 'skill://refunds/SKILL.md', name: 'refunds', description: 'Process refunds.', file: 'resources/skills/refunds/SKILL.md', fileCount: 2 },
      ])
      expect(catalog.refusals).toEqual([
        { key: 'billing/dunning/SKILL.md', message: expect.stringContaining('must match the last path segment "dunning"') },
      ])
    })

    test('should return an empty catalog for an app with no skill', async () => {
      expect(await loadMcpSkillCatalog(await readMcpSkills(app))).toEqual({ skills: [], refusals: [] })
    })
  })

  describe('guren check', () => {
    const skillKeys = (results: CheckResult[]) => results.filter((result) => result.key.startsWith('mcp-skill')).map((result) => result.key)

    test('should include the group in a full run, and count the serving warning among gating results', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('config/mcp.ts', mcpConfig('{ tokens: [] }'))
      await codegen()

      const report = await runCheck({ cwd: app })

      expect(skillKeys(report.checks)).toEqual(['mcp-skills-stale', 'mcp-skills-unserved'])
    })

    test('should run under --changed for a changed skill file, and stay out for an unrelated one', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('config/mcp.ts', SERVING)

      const touched = await runCheck({ cwd: app, changedFiles: new Set(['resources/skills/refunds/SKILL.md']) })
      const untouched = await runCheck({ cwd: app, changedFiles: new Set(['docs/notes.md']) })

      expect(skillKeys(touched.checks)).toEqual(['mcp-skills-stale', 'mcp-skills-unserved'])
      expect(skillKeys(untouched.checks)).toEqual([])
    })
  })

  describe('guren audit', () => {
    test('should fail a credential in a published skill file, and honour the ignore marker', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds'))
      await put('resources/skills/refunds/references/auth.md', 'Send this header:\n\napi_key: "sk-live-1234567890abcdef"\n')
      await put('modules/billing/resources/skills/dunning/SKILL.md', `${skillMd('dunning')}\n<!-- guren-audit-ignore -->\ntoken: "not-a-real-token-value"\n`)
      await put('resources/skills/loose/notes.md', 'password: "never-published-1234"\n')

      const report = await runAudit({ cwd: app })
      const secrets = report.findings.filter((finding) => finding.key.startsWith('secret:'))

      expect(secrets.map(({ key, status }) => ({ key, status }))).toEqual([
        { key: 'secret:resources/skills/refunds/references/auth.md:3', status: 'fail' },
      ])
      expect(secrets[0]!.message).toContain('every caller of the MCP endpoint can read')
    })
  })

  describe('tool:list', () => {
    test('should list the skills the endpoint would serve, with the refused ones as warnings', async () => {
      await put('resources/skills/refunds/SKILL.md', skillMd('refunds', 'Process refunds.'))
      await put('resources/skills/renamed/SKILL.md', skillMd('other'))

      const { skills, warnings } = await listSkills({ appRoot: app })

      expect(skills.map(({ uri, name, fileCount }) => ({ uri, name, fileCount }))).toEqual([{ uri: 'skill://refunds/SKILL.md', name: 'refunds', fileCount: 1 }])
      expect(warnings).toEqual([expect.stringContaining('resources/skills/renamed/SKILL.md: frontmatter name "other"')])
    })
  })
})
