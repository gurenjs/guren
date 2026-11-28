/**
 * `guren make:mcp-skill` (RFC 0042 §1.6): one `SKILL.md` under `resources/skills/<name>/`, in the
 * Agent Skills format the MCP endpoint serves. `guren codegen` publishes it from there.
 */
import { CliError } from './cli-error'
import { FileDiscoveryError, MCP_SKILLS_DIR } from './discovery'
import { SKILL_MANIFEST } from './mcp-skills'
import { ParseCache } from './parse-cache'
import { MCP_PLUGIN_EXPORT, scanPluginCalls, type PluginCall } from './plugin-calls'
import { resolveAppRoot, safeModuleName, writeScaffoldFile, type ScaffoldFileEntry, type WriterOptions } from './utils'

export interface MakeMcpSkillOptions extends WriterOptions {
  /** The frontmatter's `description`: what an agent reads to decide whether to load the skill. */
  description?: string
}

// The Agent Skills rule, which the endpoint's catalog applies when it loads the skill.
const SKILL_NAME_RE = /^[\da-z]+(?:-[\da-z]+)*$/u
const SKILL_NAME_LIMIT = 64
const DESCRIPTION_LIMIT = 1024
// Written as one double-quoted YAML scalar, where a line break or control character would need an escape.
const UNWRITABLE_IN_DESCRIPTION = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/u

export const MCP_SKILL_DESCRIPTION_PLACEHOLDER = 'TODO: say what this skill does and when an agent should load it.'
export const MCP_SKILLS_OPTION = "skills: { files: () => import('@/.guren/mcp-skills.gen') }"

function assertSkillName(name: string): void {
  if (name.length <= SKILL_NAME_LIMIT && SKILL_NAME_RE.test(name)) return
  throw new CliError(
    `Invalid skill name "${name}": it is the directory name and the frontmatter's \`name\`, so it must be `
    + `1-${SKILL_NAME_LIMIT} lowercase letters, digits and single hyphens (e.g. "refunds", "refund-policy").`,
  )
}

function assertDescription(description: string): void {
  const length = [...description].length
  if (length === 0 || length > DESCRIPTION_LIMIT) {
    throw new CliError(`--description must be 1-${DESCRIPTION_LIMIT} characters; it has ${length}.`)
  }
  if (UNWRITABLE_IN_DESCRIPTION.test(description)) {
    throw new CliError('--description must be one line of text, with no line break or control character.')
  }
}

export function mcpSkillTemplate(name: string, description: string = MCP_SKILL_DESCRIPTION_PLACEHOLDER): string {
  const title = name.replaceAll('-', ' ').replace(/^./u, (first) => first.toUpperCase())
  return `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${title}

Write the steps an agent follows. Name the tools it calls in order, and say what to do when one refuses.
`
}

export function mcpSkillFile(name: string, options: MakeMcpSkillOptions = {}): ScaffoldFileEntry {
  assertSkillName(name)
  if (options.description !== undefined) assertDescription(options.description)
  const dir = options.root ? `modules/${safeModuleName(options.root)}/${MCP_SKILLS_DIR}` : MCP_SKILLS_DIR
  return { path: `${dir}/${name}/${SKILL_MANIFEST}`, contents: mcpSkillTemplate(name, options.description) }
}

export async function makeMcpSkill(name: string, options: MakeMcpSkillOptions = {}): Promise<string> {
  const { path, contents } = mcpSkillFile(name, options)
  return writeScaffoldFile(path, contents, options)
}

/**
 * The line to add, only where the app's `mcpPlugin()` calls are read whole and none carries `skills`.
 * A spread or a computed key may bring the option, so such a call says nothing.
 */
export async function mcpSkillServingHint(options: WriterOptions = {}): Promise<string | undefined> {
  const appRoot = resolveAppRoot(options)
  let calls: PluginCall[]
  try {
    calls = await scanPluginCalls(appRoot, new ParseCache(), MCP_PLUGIN_EXPORT)
  } catch (error) {
    // Only this hint rests on the scan, so an unreadable directory costs the hint and not the command.
    if (error instanceof FileDiscoveryError) return undefined
    throw error
  }
  if (calls.length === 0) {
    return `No mcpPlugin() call was found. @guren/plugin-mcp serves skills: pass \`${MCP_SKILLS_OPTION}\` to mcpPlugin().`
  }
  if (calls.some((call) => call.keys.has('skills') || !call.complete)) return undefined
  return `Add \`${MCP_SKILLS_OPTION}\` to the mcpPlugin() call in ${calls[0]!.relPath} to serve it.`
}
