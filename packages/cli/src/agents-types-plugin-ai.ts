/**
 * The `@guren/plugin-ai` half of `.guren/agents.gen.ts` (RFC 0029 §11):
 * `AgentToolInputTypes` and the `AppAgentTools` augmentation that types
 * `appTools()`. Emitted only for an app depending on the plugin, since
 * TypeScript rejects augmenting an uninstalled module (TS2664).
 */
import type { DerivedAgentTool } from '@guren/server'
import type { RouteDefinitionLike } from './api-client-types'
import { schemaPropertyTypes, schemaToTypeString } from './schema-type-extractor'
import { escapeSingleQuoted, quoteObjectKey } from './utils'

export const PLUGIN_AI_PACKAGE = '@guren/plugin-ai'

export interface PluginAiTypesOptions {
  /** The definitions the tools were derived from: the Zod schemas behind a tool live only there. */
  definitions: readonly RouteDefinitionLike[]
  /** Tools whose output is already typed by an `AgentToolOutputTypes` entry. */
  resourceTyped: ReadonlySet<string>
}

/** A tool call's arguments are JSON validated against `inputSchema`, so they are typed as that schema reads. */
const JSON_INPUT = { io: 'input', json: true } as const
const JSON_OUTPUT = { io: 'output', json: true } as const

/** `tools` in the order the manifest lists them. */
export function renderPluginAiTypes(tools: readonly DerivedAgentTool[], options: PluginAiTypesOptions): string {
  const inputTypes: string[] = []
  const augmentation: string[] = []
  for (const tool of tools) {
    const key = `'${escapeSingleQuoted(tool.toolName)}'`
    const definition = findDefinition(tool, options.definitions)
    const output = options.resourceTyped.has(tool.toolName)
      ? `AgentToolOutputTypes[${key}]`
      : schemaToTypeString(definition?.schemas?.output, JSON_OUTPUT) ?? 'unknown'
    inputTypes.push(`  ${key}: ${renderInputType(tool, definition)}`)
    augmentation.push(`    ${key}: { input: AgentToolInputTypes[${key}]; output: ${output} }`)
  }

  return `
/**
 * The arguments each tool accepts, as its route's Zod contracts render them
 * (the extraction \`api-client.gen.ts\` uses), over the property set and
 * required keys of the merged \`inputSchema\` above and as that JSON Schema
 * reads: a coercing \`z.coerce.number()\` is a \`number\`, a date a \`string\`.
 * A property whose schema the extractor cannot render is \`unknown\`, never a guess.
 */
export interface AgentToolInputTypes {
${inputTypes.join('\n')}
}

// Types \`appTools()\` in @guren/plugin-ai (RFC 0029 §11): a name no route
// derives fails to compile, and each tool is typed against its contract.
// \`output\` is the success body; a gate's refusal is typed by the plugin.
declare module '@guren/plugin-ai' {
  interface AppAgentTools {
${augmentation.join('\n')}
  }
}
`
}

/** The route a tool was derived from: `deriveAgentTools()` keeps the first claim of a name. */
function findDefinition(
  tool: DerivedAgentTool,
  definitions: readonly RouteDefinitionLike[],
): RouteDefinitionLike | undefined {
  return definitions.find(
    (definition) =>
      definition.name === tool.routeName
      && definition.method.toUpperCase() === tool.method
      && definition.path === tool.path,
  )
}

/**
 * Keys, sources and required-ness come from the derivation's merge, never
 * re-derived here: only the type text of each property is new.
 */
function renderInputType(tool: DerivedAgentTool, definition: RouteDefinitionLike | undefined): string {
  const names = Object.keys(tool.inputSources)
  if (names.length === 0) return 'Record<string, never>'

  const required = new Set(tool.inputSchema.required as string[] | undefined)
  const schemas = definition?.schemas
  const propertyTypes: Record<'params' | 'query' | 'body', Record<string, string | undefined> | undefined> = {
    params: schemaPropertyTypes(schemas?.params, JSON_INPUT),
    query: schemaPropertyTypes(schemas?.query, JSON_INPUT),
    body: tool.inputBodyNested
      ? { body: schemaToTypeString(schemas?.body, JSON_INPUT) }
      : schemaPropertyTypes(schemas?.body, JSON_INPUT),
  }

  const fields = names.map((name) => {
    const source = tool.inputSources[name]!
    const type = source === 'path' ? 'string' : propertyTypes[source]?.[name]
    return `${quoteObjectKey(name)}${required.has(name) ? '' : '?'}: ${type ?? 'unknown'}`
  })
  return `{ ${fields.join('; ')} }`
}
