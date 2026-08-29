/**
 * Generates the agent tool manifest from route contracts (RFC 0016 §2, §6).
 *
 * The derivation itself is `deriveAgentTools()` in `@guren/core` — the same
 * call a protocol adapter makes at runtime — so a generated manifest and a
 * live MCP server can never disagree about a tool's name, schemas, or
 * exposure. What this module adds is the half that only exists in the CLI:
 * `Router.definitions()` carries a `resource` hint as a *class name*, while
 * the payload type behind that name lives in the AST extraction behind
 * `data.gen.ts`. So a tool whose route declares a hint (and binds no `output`
 * schema) gets that type text appended to its description and a type-level
 * `Data.*` reference in `AgentToolOutputTypes`.
 *
 * Runs after the data generator and before the API client, for the reason
 * both orderings share: it consumes the Resource definitions the first
 * produced, and the `Data` import it emits resolves against the sibling
 * `data.gen.ts`.
 *
 * Apps whose routes declare no `.agent()` metadata get no file, and a
 * previously generated one is removed — a stale manifest describing tools the
 * app no longer exposes is worse than none, and this is positive evidence: the
 * route graph loaded, it simply has no agent routes.
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
import { escapeSingleQuoted, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export const AGENTS_MANIFEST_FILE = '.guren/agents.gen.ts'

/**
 * The slice of data-types' ResourceDefinition this generator needs. Same shape
 * the API client resolves hints against, plus `rawType` — the extracted type
 * *text*, which is what an agent reads in a description (a `Data.Post`
 * reference means nothing to a model).
 */
export type AgentResourceRef = ResourceTypeRef & Pick<ResourceDefinition, 'rawType'>

export interface GenerateAgentTypesOptions extends WriterOptions {
  appRoot?: string
  outputFile?: string
  /**
   * Resource classes discovered by `generateDataTypes()`. Without them a
   * `resource` hint resolves to nothing and the tool keeps the description its
   * route declared — no type text, no `AgentToolOutputTypes` entry.
   */
  resources?: AgentResourceRef[]
}

/**
 * Whether an app's route sources declare agent metadata at all.
 *
 * Positive evidence for a *lifecycle* question — should `.guren/agents.gen.ts`
 * exist? — asked by `guren check` and `guren doctor`, neither of which can
 * afford to evaluate the app's module graph to find out. So this is a string
 * scan over the same route files the path checks read: `.agent(` for the
 * builder, `agent:` for the route-contract and `resource()` option keys.
 *
 * It errs toward "no": a false negative costs a missing warning about a
 * manifest codegen would have written anyway, while a false positive nags an
 * app that has no tools. Deliberately not a substitute for the derivation —
 * nothing decides *exposure* from this.
 */
export async function appDeclaresAgentRoutes(cwd: string, routesFile?: string): Promise<boolean> {
  const files = await discoverRoutePathFiles(cwd, routesFile)
  const sources = await Promise.all(
    files.map(async (file) => {
      try {
        return await readFile(file, 'utf-8')
      } catch {
        return ''
      }
    }),
  )
  return sources.some((source) => /\.agent\s*\(|(?:^|[{,(\s])agent\s*:/u.test(source))
}

export async function generateAgentTypes(
  definitions: RouteDefinition[],
  options: GenerateAgentTypesOptions = {},
): Promise<{ outputPath: string; tools: DerivedAgentTool[]; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, options.outputFile ?? AGENTS_MANIFEST_FILE)

  // Returned rather than logged, same contract as `generateDataTypes`:
  // `guren codegen` prints them, and the MCP codegen tool hands them to the
  // agent that asked for the run.
  const { tools, warnings } = deriveAgentTools(definitions)

  if (tools.length === 0) {
    await rm(outputFile, { force: true })
    // An empty path is the "nothing to describe" signal every generator uses
    // — the MCP codegen tool reads exactly this to report a skip rather than
    // an artifact it would then fail to find.
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
   * The extracted type text, embedded in the description — absent when a
   * resolved leaf has no copied body to embed. `data.gen.ts` emits some
   * payload types as `import('…').Name` references (a `z.infer<>`, a merged
   * interface), and an agent reading a path into the app's source learns
   * nothing it can act on. The type-level reference below still works, so
   * only the prose half is dropped.
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
 * appears as the type it accepts. \`outputSchema\` is present only for routes
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
 * Resolve the `resource` hint behind a tool, if any.
 *
 * Skipped entirely for a tool that already advertises an `outputSchema`: RFC
 * 0016's output ladder puts the `output` schema above the hint, and it is the
 * only one of the two the runtime enforces. Appending a hint's type text
 * beside it would describe the same response twice, with nothing keeping the
 * two in agreement.
 */
function resolveEnrichment(
  tool: DerivedAgentTool,
  declared: Map<string, AgentResourceRef[]>,
  warnings?: string[],
): ResourceEnrichment | undefined {
  const shape = tool.resource
  if (!shape || tool.outputSchema) return undefined

  // Two passes over one resolution rule: which class names resolve is decided
  // once, in `resolveResourceShapeType`; only what a resolved leaf renders as
  // differs. `describable` tracks the leaves whose payload type was not copied
  // into `data.gen.ts` as a body — see ResourceEnrichment.typeText.
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
  // built around an unresolved leaf would claim a shape the server does not
  // send, and a tool description is read by something that cannot check.
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
 * The response text appended to a description. Kept prose-shaped rather than
 * dropped in as a bare type: the reader is a model choosing whether to call
 * the tool, and an unlabelled brace body reads as part of the sentence above
 * it.
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
  if (tool.outputSchema) fields.push(`outputSchema: ${renderLiteral(tool.outputSchema, '    ')}`)
  fields.push(`annotations: ${renderLiteral(tool.annotations, '    ')}`)
  if (tool.authorization) fields.push(`authorization: ${renderLiteral(tool.authorization, '    ')}`)
  if (tool.approval) fields.push(`approval: ${JSON.stringify(tool.approval)}`)
  if (tool.redact) fields.push(`redact: ${renderLiteral(tool.redact, '    ')}`)
  fields.push(`expose: ${renderLiteral(tool.expose, '    ')}`)

  return `  '${escapeSingleQuoted(tool.toolName)}': {\n${fields.map((field) => `    ${field},`).join('\n')}\n  },`
}

/**
 * A JSON literal, re-indented to sit where it is written. `JSON.stringify` is
 * the renderer rather than a hand-rolled one because everything emitted here
 * *is* JSON — JSON Schema objects, booleans, string arrays — and it escapes
 * every string the same way TypeScript reads it.
 */
function renderLiteral(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`)
}
