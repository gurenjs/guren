/**
 * Generates the agent tool manifest from route contracts (RFC 0016 §2, §6).
 * The derivation is `deriveAgentTools()` in `@guren/core`, the same call a
 * runtime adapter makes, so a manifest and a live MCP server cannot disagree.
 * What this adds is CLI-only: definitions carry a `resource` hint as a class
 * name, and the payload type behind it lives in `data.gen.ts`'s AST extraction —
 * hence running after the data generator. An app with no derivable tools gets no
 * file, and a stale one is removed.
 */
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deriveAgentTools, type DerivedAgentTool, type RouteDefinition } from '@guren/core'
import type { ResourceDefinition } from './data-types'
import {
  describeDeclarations,
  groupResourcesByClassName,
  quoteNames,
  resolveResourceShapeType,
  type ResourceTypeRef,
} from './api-client-types'
import { discoverRoutePathFiles } from './route-path-check'
import { fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { escapeSingleQuoted, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export const AGENTS_MANIFEST_FILE = '.guren/agents.gen.ts'

/**
 * What the API client resolves hints against, plus `rawType`: the extracted type
 * text, since a `Data.Post` reference means nothing to a model reading a description.
 */
export type AgentResourceRef = ResourceTypeRef & Pick<ResourceDefinition, 'rawType'>

export interface GenerateAgentTypesOptions extends WriterOptions {
  appRoot?: string
  outputFile?: string
  /** Resource classes from `generateDataTypes()`; without them a `resource` hint resolves to nothing. */
  resources?: AgentResourceRef[]
}

/**
 * Whether an app's route sources mention agent metadata at all — a cheap string
 * scan, so `check` and `doctor` need not evaluate the module graph. Nothing decides
 * *exposure* from this, only whether {@link planAgentManifest} falls through to
 * `deriveAgentTools()`. An unreadable file therefore counts as declaring; a "no"
 * would turn an unreadable routes directory into a clean bill of health.
 */
export async function appDeclaresAgentRoutes(cwd: string, routesFile?: string): Promise<boolean> {
  const files = await discoverRoutePathFiles(cwd, routesFile)
  const declaring = await Promise.all(
    files.map(async (file) => {
      try {
        return AGENT_DECLARATION_PATTERN.test(await readFile(file, 'utf-8'))
      } catch {
        return true
      }
    }),
  )
  return declaring.some(Boolean)
}

/** `.agent(` for the builder, `agent:` for the route-contract and `resource()` option keys. */
const AGENT_DECLARATION_PATTERN = /\.agent\s*\(|(?:^|[{,(\s])agent\s*:/u

export interface AgentManifestPlan {
  /**
   * `tools` — codegen writes the manifest. `no-tools` — it writes nothing and
   * removes any file already there. `unreadable` — nothing is claimed either way.
   */
  reason: 'tools' | 'no-tools' | 'unreadable'
  toolCount: number
  /** A manifest on disk that codegen would not write — and would delete. */
  staleManifest: boolean
  /** Why the route graph could not be loaded (`reason: 'unreadable'` only). */
  loadError?: string
}

/**
 * The one rule for "does this app get a `.guren/agents.gen.ts`?", which `check`
 * and `doctor` read rather than restate. The condition is *derivation produces at
 * least one tool*, not "a route mentions .agent()": a `.agent()` route with no
 * `.name()` makes codegen delete the manifest, so a check keyed on the string scan
 * would loop. `preloadedDefinitions` skips the load for a caller holding the graph.
 */
export async function planAgentManifest(
  cwd: string,
  routesFile: string = DEFAULT_ROUTES_FILE,
  preloadedDefinitions?: RouteDefinition[],
): Promise<AgentManifestPlan> {
  const present = await fileExists(cwd, AGENTS_MANIFEST_FILE)

  let definitions = preloadedDefinitions
  if (definitions === undefined) {
    if (!present && !(await appDeclaresAgentRoutes(cwd, routesFile))) {
      return { reason: 'no-tools', toolCount: 0, staleManifest: false }
    }

    if (!(await fileExists(cwd, routesFile))) {
      return { reason: 'no-tools', toolCount: 0, staleManifest: present }
    }

    try {
      definitions = await loadRouteDefinitions(resolve(cwd, routesFile), cwd)
    } catch (error) {
      // Never swallowed: silence is indistinguishable from an app that exposes nothing.
      return {
        reason: 'unreadable',
        toolCount: 0,
        staleManifest: false,
        loadError: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const { tools } = deriveAgentTools(definitions)
  return {
    reason: tools.length > 0 ? 'tools' : 'no-tools',
    toolCount: tools.length,
    staleManifest: present && tools.length === 0,
  }
}

export async function generateAgentTypes(
  definitions: RouteDefinition[],
  options: GenerateAgentTypesOptions = {},
): Promise<{ outputPath: string; tools: DerivedAgentTool[]; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, options.outputFile ?? AGENTS_MANIFEST_FILE)

  // Returned rather than logged, same contract as `generateDataTypes`.
  const { tools, warnings } = deriveAgentTools(definitions)

  if (tools.length === 0) {
    await rm(outputFile, { force: true })
    // An empty path is every generator's "nothing to describe" signal.
    return { outputPath: '', tools, warnings }
  }

  const content = buildAgentToolsContent(tools, { resources: options.resources, warnings })
  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, content, { force: options.force })

  return { outputPath, tools, warnings }
}

export interface BuildAgentToolsOptions {
  resources?: AgentResourceRef[]
  /** Sink for per-tool notes about hints that could not be resolved. */
  warnings?: string[]
}

/** What a `resource` hint contributed to one tool, once resolved. */
interface ResourceEnrichment {
  /**
   * The extracted type text embedded in the description, absent when the leaf
   * has no copied body: `data.gen.ts` emits some payload types as `import('…')`
   * references, from which a model learns nothing. Only the prose half is dropped.
   */
  typeText?: string
  /** The `Data.*` reference, emitted in `AgentToolOutputTypes`. */
  dataType: string
}

export function buildAgentToolsContent(
  tools: DerivedAgentTool[],
  options: BuildAgentToolsOptions = {},
): string {
  const declared = groupResourcesByClassName(options.resources)
  const sorted = [...tools].sort((a, b) => a.toolName.localeCompare(b.toolName))

  let importsData = false
  const outputTypes: string[] = []
  const entries = sorted.map((tool) => {
    const enrichment = resolveEnrichment(tool, declared, options.warnings)
    if (enrichment) {
      importsData = true
      outputTypes.push(`  '${escapeSingleQuoted(tool.toolName)}': ${enrichment.dataType}`)
    }
    return renderTool(tool, enrichment)
  })

  const dataImport = importsData ? "\nimport type { Data } from './data.gen'\n" : ''

  return `// Generated — DO NOT EDIT
// Run \`guren codegen\` to regenerate.
${dataImport}
/**
 * Agent tools derived from the routes that declare \`.agent()\` metadata
 * (RFC 0016). Every field here comes from a contract the route already
 * carries — nothing is restated by hand, so a tool cannot advertise a schema
 * the endpoint does not validate.
 *
 * \`inputSchema\` merges the route's \`params\`, \`query\` and \`body\` schemas into
 * one JSON Schema 2020-12 object, with path parameters supplemented as
 * required strings; it describes what a caller *sends*, so a coercing schema
 * appears as the type it accepts. \`inputSources\` records which of those
 * contracts each merged property came from, and \`inputBodyNested\` marks a
 * route whose non-object body was nested under a \`body\` key to give the tool
 * an object root; together they are what lets a client rebuild the HTTP
 * request from a flat tool call. \`outputSchema\` is present only for routes
 * that bind an \`output\` schema — the one shape validated at runtime. Routes
 * that instead declare a \`resource\` hint carry its payload type in the
 * description and in {@link AgentToolOutputTypes}.
 *
 * \`annotations\` are MCP \`ToolAnnotations\`, resolved to explicit values. They
 * are hints for client UX, never enforcement: authorization lives in policies
 * and scopes, and \`authorization.ability\` here reports the policy ability the
 * route's middleware chain checks, when that is statically derivable.
 */
export const agentTools = {
${entries.join('\n')}
} as const

export type AgentToolName = keyof typeof agentTools

/**
 * The payload shape each tool's route declares through a \`resource\` response
 * hint — declared, not validated: the server never checks its response
 * against this. Tools that bind an \`output\` schema are absent; their
 * \`outputSchema\` is the enforced contract and needs no type-level twin.
 */
export interface AgentToolOutputTypes {
${outputTypes.length > 0 ? outputTypes.join('\n') : '  // No tool declares a resolvable resource response hint.'}
}
`
}

/**
 * Skipped for a tool that already advertises an `outputSchema`: RFC 0016's
 * output ladder puts that above the hint, and it is the only one the runtime
 * enforces — describing the response twice keeps neither half in agreement.
 */
function resolveEnrichment(
  tool: DerivedAgentTool,
  declared: Map<string, AgentResourceRef[]>,
  warnings?: string[],
): ResourceEnrichment | undefined {
  const shape = tool.resource
  if (!shape || tool.outputSchema) return undefined

  // Two passes over one resolution rule: only what a resolved leaf renders as
  // differs. `describable` tracks leaves with no copied body (ResourceEnrichment.typeText).
  let describable = true
  const typeText = resolveResourceShapeType(shape, declared, (ref) => {
    if (ref.rawType === null || ref.rawType.startsWith('import(')) {
      describable = false
      return 'unknown'
    }
    return ref.rawType
  })
  const dataType = resolveResourceShapeType(shape, declared, (ref) => `Data.${ref.dataName}`)

  // All-or-nothing, the rule the API client applies to the same hint: a type
  // built around an unresolved leaf claims a shape the server does not send.
  if (typeText.missing.size > 0) {
    warnings?.push(
      `Tool "${tool.toolName}" declares a resource response hint referencing `
        + `${quoteNames(typeText.missing)}, but no matching Resource class was found in `
        + 'app/Http/Resources (at the project root or under modules/*) — response left undescribed.',
    )
  }
  if (typeText.unresolved.size > 0) {
    warnings?.push(
      `Tool "${tool.toolName}" declares a resource response hint referencing `
        + `${quoteNames(typeText.unresolved)}, which does not resolve to exactly one generated `
        + `type (${Array.from(typeText.unresolved)
          .flatMap((name) => describeDeclarations(declared.get(name) ?? []))
          .join('; ')}) — a hint carries only the class name, so it cannot say which. `
        + 'Response left undescribed; see the data.gen.ts warnings above.',
    )
  }
  if (typeText.missing.size > 0 || typeText.unresolved.size > 0 || !typeText.usedData) {
    return undefined
  }

  return { typeText: describable ? typeText.type : undefined, dataType: dataType.type }
}

/**
 * Prose-shaped rather than a bare type: the reader is a model choosing whether
 * to call the tool, and an unlabelled brace body reads as part of the sentence above.
 */
function describeResponse(typeText: string): string {
  return `Returns: ${typeText}`
}

function renderTool(tool: DerivedAgentTool, enrichment: ResourceEnrichment | undefined): string {
  const description = enrichment?.typeText
    ? [tool.description, describeResponse(enrichment.typeText)].filter(Boolean).join('\n\n')
    : tool.description

  const fields: string[] = [
    `toolName: ${JSON.stringify(tool.toolName)}`,
    `routeName: ${JSON.stringify(tool.routeName)}`,
    `method: ${JSON.stringify(tool.method)}`,
    `path: ${JSON.stringify(tool.path)}`,
  ]
  if (description !== undefined) fields.push(`description: ${JSON.stringify(description)}`)
  fields.push(`inputSchema: ${renderLiteral(tool.inputSchema, '    ')}`)
  // Through `renderLiteral`, not `JSON.stringify`: the keys are argument names,
  // and an argument may legally be called `__proto__`.
  fields.push(`inputSources: ${renderLiteral(tool.inputSources, '    ')}`)
  fields.push(`inputBodyNested: ${JSON.stringify(tool.inputBodyNested)}`)
  if (tool.outputSchema) fields.push(`outputSchema: ${renderLiteral(tool.outputSchema, '    ')}`)
  fields.push(`annotations: ${renderLiteral(tool.annotations, '    ')}`)
  if (tool.authorization) fields.push(`authorization: ${renderLiteral(tool.authorization, '    ')}`)
  if (tool.approval) fields.push(`approval: ${JSON.stringify(tool.approval)}`)
  if (tool.redact) fields.push(`redact: ${renderLiteral(tool.redact, '    ')}`)
  fields.push(`expose: ${renderLiteral(tool.expose, '    ')}`)

  return `  ${renderToolKey(tool.toolName)}: {\n${fields.map((field) => `    ${field},`).join('\n')}\n  },`
}

/**
 * Same hazard as {@link renderLiteral}'s keys: `'__proto__': { … }` sets the
 * object's [[Prototype]] instead of defining a property, so the tool would be
 * absent from every lookup. A route may legally be named `__proto__` — the MCP
 * grammar permits it, and tool names are route names verbatim. The
 * `AgentToolOutputTypes` entries need no such care; a type is never evaluated.
 */
function renderToolKey(toolName: string): string {
  const quoted = `'${escapeSingleQuoted(toolName)}'`
  return toolName === '__proto__' ? `[${quoted}]` : quoted
}

/**
 * A JSON value as a TypeScript literal, indented to sit where it is written.
 * Not `JSON.stringify`: a JSON Schema property may legally be named `__proto__`
 * (a path parameter can be), and `{ "__proto__": … }` sets [[Prototype]] instead
 * of defining a property; the computed form defines it. Leaves still go through
 * `JSON.stringify`, so every string is escaped as TypeScript reads it.
 */
function renderLiteral(value: unknown, indent: string): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  const inner = `${indent}  `

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => `${inner}${renderLiteral(item, inner)}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }

  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const rendered = entries.map(
    ([key, item]) => `${inner}${renderObjectKey(key)}: ${renderLiteral(item, inner)}`,
  )
  return `{\n${rendered.join(',\n')}\n${indent}}`
}

/** See {@link renderLiteral}: only `__proto__` needs the computed form. */
function renderObjectKey(key: string): string {
  return key === '__proto__' ? `[${JSON.stringify(key)}]` : JSON.stringify(key)
}
