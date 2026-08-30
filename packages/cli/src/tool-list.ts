/**
 * `guren tool:list` / `guren tool:inspect` — what this app exposes to agents
 * (RFC 0016 §6).
 *
 * Both derive live, from the route graph on disk, rather than reading
 * `.guren/agents.gen.ts`: a manifest can be stale or absent, and the question
 * these answer ("what would an agent see right now?") is only useful when the
 * answer comes from the same `deriveAgentTools()` call an adapter makes. The
 * gap between the two — a `resource` hint's payload type — is codegen-only and
 * named as such where it shows.
 *
 * The `tool:` namespace is new; `agent:init` / `agent:sync` already own
 * `agent:` for the coding-agent harness, which is a different surface
 * entirely.
 */
import { consola } from 'consola'
import {
  deriveAgentTools,
  type DeriveAgentToolsResult,
  type DerivedAgentTool,
  type ResourceResponseShape,
} from '@guren/core'
import { loadAppRouteDefinitions } from './load-routes'

export interface ToolListOptions {
  /** Routes entry file path. */
  routesFile?: string
  /** Application root directory. */
  appRoot?: string
}

export async function listTools(options: ToolListOptions = {}): Promise<DeriveAgentToolsResult> {
  const { definitions } = await loadAppRouteDefinitions(options)
  return deriveAgentTools(definitions)
}

/** Compact annotation flags, in the order the MCP spec lists them. */
function describeAnnotations(tool: DerivedAgentTool): string {
  const flags: string[] = []
  if (tool.annotations.readOnlyHint) flags.push('read-only')
  if (tool.annotations.destructiveHint) flags.push('destructive')
  if (tool.annotations.idempotentHint) flags.push('idempotent')
  if (tool.approval === 'required') flags.push('approval')
  return flags.length > 0 ? flags.join(', ') : '-'
}

/** Aligned `Label: value` lines — the longest label is `Authorization`. */
function field(label: string, value: string): string {
  return `${`${label}:`.padEnd(15)}${value}`
}

/** Every Resource class a hint names, in the order the shape declares them. */
function resourceClassNames(shape: ResourceResponseShape): string[] {
  if (typeof shape === 'string') return [shape]
  if (Array.isArray(shape)) return resourceClassNames(shape[0])
  return Object.values(shape).flatMap(resourceClassNames)
}

function describeAuthorization(tool: DerivedAgentTool): string {
  // A dash, not "none": absence means the ability is not statically
  // derivable, which is a different claim from "this route is unguarded".
  return tool.authorization ? tool.authorization.ability : '-'
}

export async function displayTools(options: ToolListOptions & { json?: boolean } = {}): Promise<void> {
  const { tools, warnings } = await listTools(options)

  if (options.json) {
    console.log(JSON.stringify({ tools, warnings }, null, 2))
    return
  }

  for (const warning of warnings) {
    consola.warn(warning)
  }

  if (tools.length === 0) {
    consola.warn('No agent tools found. Declare .agent() on a named route to expose one.')
    return
  }

  printToolTable([...tools].sort((a, b) => a.toolName.localeCompare(b.toolName)))
}

function printToolTable(tools: DerivedAgentTool[]): void {
  const columns: Array<[header: string, value: (tool: DerivedAgentTool) => string]> = [
    ['Tool', (tool) => tool.toolName],
    ['Method', (tool) => tool.method],
    ['Path', (tool) => tool.path],
    ['MCP', (tool) => (tool.expose.mcp ? 'yes' : 'no')],
    ['WebMCP', (tool) => (tool.expose.webMcp ? 'yes' : 'no')],
    ['Auth', describeAuthorization],
    ['Annotations', describeAnnotations],
  ]

  const rows = tools.map((tool) => columns.map(([, value]) => value(tool)))
  const widths = columns.map(([header], index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  )

  const header = columns.map(([label], index) => label.padEnd(widths[index]!)).join(' | ')
  console.log('\x1b[1m' + header + '\x1b[0m')
  console.log('-'.repeat(header.length))
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index]!)).join(' | '))
  }

  console.log('')
  console.log(`Total: ${tools.length} tool${tools.length === 1 ? '' : 's'}`)
}

export async function displayToolInspection(
  name: string,
  options: ToolListOptions & { json?: boolean } = {},
): Promise<void> {
  const { tools, warnings } = await listTools(options)
  const tool = tools.find((candidate) => candidate.toolName === name)

  if (!tool) {
    const available = tools.map((candidate) => candidate.toolName).sort()
    throw new Error(
      `No agent tool named "${name}".`
        + (available.length > 0
          ? ` Available tools: ${available.join(', ')}.`
          : ' This app exposes no agent tools — declare .agent() on a named route.'),
    )
  }

  // Only this tool's warnings: the rest belong to routes the caller did not
  // ask about, and burying the one line that concerns this tool among them is
  // how an inspect command stops being read. Read off the tool rather than
  // filtered out of the aggregate by prefix — the prefix is a printing
  // convention, not a contract to parse back.
  const relevant = tool.warnings

  if (options.json) {
    console.log(JSON.stringify({ tool, warnings: relevant }, null, 2))
    return
  }

  console.log(`\x1b[1m${tool.toolName}\x1b[0m  ${tool.method} ${tool.path}`)
  if (tool.routeName !== tool.toolName) console.log(field('Route', tool.routeName))
  console.log(field('Description', tool.description ?? '(none)'))
  console.log(field('Exposure', `mcp=${tool.expose.mcp ? 'yes' : 'no'} webMcp=${tool.expose.webMcp ? 'yes' : 'no'}`))
  console.log(field('Annotations', describeAnnotations(tool)))
  console.log(field('Authorization', tool.authorization ? tool.authorization.ability : '(not statically derivable)'))
  if (tool.approval) console.log(field('Approval', tool.approval))
  if (tool.redact) console.log(field('Redacted', tool.redact.join(', ')))

  console.log('')
  console.log('\x1b[1mInput\x1b[0m')
  const properties = tool.inputSchema.properties ?? {}
  const required = new Set(tool.inputSchema.required ?? [])
  const names = Object.keys(properties)
  if (names.length === 0) {
    console.log('  (no arguments)')
  } else {
    for (const propertyName of names) {
      const schema = properties[propertyName]!
      const type = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type ?? 'unknown'
      console.log(`  ${propertyName}${required.has(propertyName) ? '' : '?'}: ${type}`)
    }
  }

  console.log('')
  console.log('\x1b[1mOutput\x1b[0m')
  if (tool.outputSchema) {
    console.log(JSON.stringify(tool.outputSchema, null, 2))
  } else if (tool.resource) {
    // The hint's payload *type* lives in the CLI's AST extraction over
    // app/Http/Resources, not in the route graph this command reads — so name
    // the Resource class the reader can open, rather than pointing at a
    // generated file that may not exist (this command derives live precisely
    // because it must answer without one).
    const classes = resourceClassNames(tool.resource)
    console.log(`  (no output schema; response declared by ${classes.join(', ')})`)
  } else {
    console.log('  (no output schema)')
  }

  if (relevant.length > 0) {
    console.log('')
    for (const warning of relevant) {
      consola.warn(warning)
    }
  }
}
