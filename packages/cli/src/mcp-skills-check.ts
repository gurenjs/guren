/**
 * `guren check`'s MCP skills group (RFC 0042 §1.6), silent for an app with no skill, no generated module and no import of one.
 * Whether a skill is served is the SDK's verdict, asked through the same `SkillsExtension.load()` the endpoint calls
 * at boot, over the same contents codegen publishes: the CLI reads no frontmatter of its own.
 * Layout, size and wiring are the CLI's: `readMcpSkills()` for what is published, `plugin-calls.ts` for `mcpPlugin()`.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { advisory, check, formatFixCommand, type CheckFix, type CheckResult } from './check-result'
import { MCP_SKILLS_MODULE, MCP_SKILLS_OPTION, planMcpSkillsModule, SKILL_MANIFEST, type DiscoveredSkill, type McpSkillsContent } from './mcp-skills'
import type { ParseCache } from './parse-cache'
import { MCP_PLUGIN_EXPORT, scanPluginCalls } from './plugin-calls'

/** What the extension requires every host to accept and recommends servers stay under, per skill. */
export const SKILL_FILE_LIMIT = 512
export const SKILL_BYTE_LIMIT = 16 * 1024 * 1024
/** What Claude Code documents for the skills it loads from a server. Advisory: a host changes these without notice. */
export const HOST_TEXT_FILE_BYTES = 100_000
export const HOST_SKILL_BYTES = 400_000
export const HOST_SKILL_COUNT = 100

const TITLE = 'MCP skills'

export interface CatalogSkill {
  uri: string
  name: string
  description: string
  /** The app-relative `SKILL.md`. */
  file: string
  fileCount: number
}

export interface McpSkillCatalog {
  /** The skills the endpoint would serve from these contents, in the catalog's order. */
  skills: CatalogSkill[]
  /** What the SDK reported while building it, each against the published key it names. */
  refusals: Array<{ key: string; message: string }>
}

/**
 * The catalog the endpoint builds at boot from these contents. The SDK's size limits are lifted here,
 * since `guren check` judges them itself and a skill over them is still served.
 */
export async function loadMcpSkillCatalog(content: McpSkillsContent): Promise<McpSkillCatalog> {
  const contents: Record<string, string | Uint8Array> = { ...content.files }
  for (const [key, base64] of Object.entries(content.binary)) contents[key] = Buffer.from(base64, 'base64')
  if (Object.keys(contents).length === 0) return { skills: [], refusals: [] }

  // Loaded on demand: only an app with skills pays for the SDK.
  const { memorySkillFiles, SkillsExtension } = await import('@modelcontextprotocol/server/ext/skills')
  const refusals: McpSkillCatalog['refusals'] = []
  const catalog = await SkillsExtension.load(memorySkillFiles(contents), {
    limits: { files: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY },
    onWarning: ({ path, message }) => refusals.push({ key: path, message }),
  })

  const skills = catalog.entries.map((entry): CatalogSkill => {
    const key = decodeURIComponent(entry.uri.slice('skill://'.length))
    return {
      uri: entry.uri,
      name: entry.frontmatter.name,
      description: entry.frontmatter.description,
      file: content.sources[key] ?? key,
      fileCount: Array.isArray(entry.resources) ? entry.resources.length : 0,
    }
  })
  return { skills, refusals }
}

export interface McpSkillsCheckOptions {
  cwd: string
  cache: ParseCache
  /** The codegen command that rewrites the module, as the run's other generated files name it. */
  fix: CheckFix
}

export async function checkMcpSkills({ cwd, cache, fix }: McpSkillsCheckOptions): Promise<CheckResult[]> {
  const { content, source } = await planMcpSkillsModule(cwd)
  // No module is due and nothing was found: the app has no skills, and none it meant to have.
  if (source === null && content.problems.length === 0) return []
  const current = await readFile(resolve(cwd, MCP_SKILLS_MODULE), 'utf8').catch(() => null)

  return [
    ...layoutFindings(content),
    ...(await catalogFindings(content)),
    ...sizeFindings(content),
    ...moduleFindings(source, current, fix),
    ...(content.skills.length > 0 ? await servingFindings(cwd, cache, content.skills) : []),
  ]
}

function layoutFindings(content: McpSkillsContent): CheckResult[] {
  return content.problems.map((problem) => {
    if (problem.kind === 'misnamed') {
      return check(
        `mcp-skill-manifest:${problem.file}`,
        TITLE,
        'fail',
        `${problem.file} is not a skill's manifest, so its directory is not published: the name is case-sensitive.`,
        `Rename it to ${SKILL_MANIFEST}.`,
        problem.file,
      )
    }
    const message = problem.kind === 'collision'
      ? `${problem.file} is not published: ${problem.kept} already takes skill://${problem.key}.`
      : `${problem.file} sits inside the skill ${problem.outer}. The MCP endpoint refuses a nested skill at boot.`
    return check(
      `mcp-skill-namespace:${problem.file}`,
      TITLE,
      'fail',
      message,
      'Move the inner skill out, or rename a root skill that carries the name of a module with skills.',
      problem.file,
    )
  })
}

async function catalogFindings(content: McpSkillsContent): Promise<CheckResult[]> {
  let catalog: McpSkillCatalog
  try {
    catalog = await loadMcpSkillCatalog(content)
  } catch (error) {
    return [check('mcp-skill-frontmatter', TITLE, 'fail', `The skill catalog could not be built: ${error instanceof Error ? error.message : String(error)}`)]
  }
  return catalog.refusals.flatMap(({ key, message }) => {
    // A warning about the whole tree ("no skills found") names no file; each skill's own refusal says why.
    const file = content.sources[key]
    if (file === undefined) return []
    return [check(`mcp-skill-frontmatter:${file}`, TITLE, 'fail', `${file}: ${message}.`, 'Fix the file; the endpoint leaves the skill out until then.', file)]
  })
}

function skillBytes(skill: DiscoveredSkill, content: McpSkillsContent): { files: number; bytes: number } {
  const published = skill.files.filter((file) => content.sources[file.key] !== undefined)
  return { files: published.length, bytes: published.reduce((total, file) => total + (content.sizes[file.key] ?? 0), 0) }
}

const kilobytes = (bytes: number): string => `${Math.ceil(bytes / 1000)} KB`

function sizeFindings(content: McpSkillsContent): CheckResult[] {
  const results: CheckResult[] = []
  for (const skill of content.skills) {
    const { files, bytes } = skillBytes(skill, content)
    const manifest = content.sources[`${skill.path}/${SKILL_MANIFEST}`]
    if (files > SKILL_FILE_LIMIT || bytes > SKILL_BYTE_LIMIT) {
      results.push(check(
        `mcp-skill-limit:${manifest}`,
        TITLE,
        'fail',
        `The skill ${skill.path} holds ${files} files and ${kilobytes(bytes)}, over the ${SKILL_FILE_LIMIT} files or 16 MiB every host is required to accept.`,
        'Move reference material out of the skill, or split the skill.',
        manifest,
      ))
    } else if (bytes > HOST_SKILL_BYTES) {
      results.push(advisory(
        `mcp-skill-host-limit:${manifest}`,
        TITLE,
        'warn',
        `The skill ${skill.path} is ${kilobytes(bytes)}. Claude Code documents a limit of ${kilobytes(HOST_SKILL_BYTES)} for a skill it loads from a server.`,
        'Trim the skill if its readers use such a host.',
        manifest,
      ))
    }
    for (const file of skill.files) {
      const size = content.sizes[file.key] ?? 0
      if (content.files[file.key] === undefined || size <= HOST_TEXT_FILE_BYTES) continue
      results.push(advisory(
        `mcp-skill-host-limit:${content.sources[file.key]}`,
        TITLE,
        'warn',
        `${content.sources[file.key]} is ${kilobytes(size)}. Claude Code documents a limit of ${kilobytes(HOST_TEXT_FILE_BYTES)} for a text file of a skill.`,
        'Split the file if its readers use such a host.',
        content.sources[file.key],
      ))
    }
  }
  if (content.skills.length > HOST_SKILL_COUNT) {
    results.push(advisory(
      'mcp-skill-host-limit',
      TITLE,
      'warn',
      `The app publishes ${content.skills.length} skills. Claude Code documents a limit of ${HOST_SKILL_COUNT} skills per server.`,
      'Merge related skills if their readers use such a host.',
    ))
  }
  return results
}

function moduleFindings(source: string | null, current: string | null, fix: CheckFix): CheckResult[] {
  if (source === null) return []
  if (current === source) return [check('mcp-skills-stale', MCP_SKILLS_MODULE, 'pass', `${MCP_SKILLS_MODULE} is current.`)]
  return [{
    ...check(
      'mcp-skills-stale',
      MCP_SKILLS_MODULE,
      'fail',
      current === null ? `${MCP_SKILLS_MODULE} is missing.` : `${MCP_SKILLS_MODULE} differs from the skills it is generated from, so the endpoint serves the older files.`,
      `Run: ${formatFixCommand(fix)}`,
      MCP_SKILLS_MODULE,
    ),
    fix,
  }]
}

async function servingFindings(cwd: string, cache: ParseCache, skills: readonly DiscoveredSkill[]): Promise<CheckResult[]> {
  const key = 'mcp-skills-unserved'
  const count = `${skills.length} skill${skills.length === 1 ? '' : 's'}`
  const add = `Pass \`${MCP_SKILLS_OPTION}\` to mcpPlugin().`
  const calls = await scanPluginCalls(cwd, cache, MCP_PLUGIN_EXPORT)

  const serving = calls.find((call) => call.keys.has('skills'))
  if (serving) return [check(key, TITLE, 'pass', `The mcpPlugin() call in ${serving.relPath} carries skills (${count}).`, undefined, serving.relPath)]

  const opaque = calls.find((call) => !call.complete)
  if (opaque) {
    return [advisory(
      key,
      TITLE,
      'warn',
      `Serving of the ${count} is unverified: the mcpPlugin() call in ${opaque.relPath} takes options this check cannot read whole (a spread, a computed key or a variable).`,
      `Write the skills option in the call itself, or confirm the options carry it. ${add}`,
      opaque.relPath,
    )]
  }
  if (calls.length === 0) {
    return [check(key, TITLE, 'warn', `The app has ${count} and no mcpPlugin() call, so no endpoint serves them.`, `Register @guren/plugin-mcp. ${add}`)]
  }
  return [check(
    key,
    TITLE,
    'warn',
    `The app has ${count}, but the mcpPlugin() call in ${calls[0]!.relPath} has no skills option, so the endpoint serves none of them.`,
    add,
    calls[0]!.relPath,
  )]
}
