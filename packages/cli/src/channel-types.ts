import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { walk, type BabelNode } from './ast-walk'
import { parseSourceFile } from './parse-cache'
import { writeGeneratedFile, type WriterOptions } from './utils'

export interface GenerateChannelTypesOptions extends WriterOptions {
  appRoot?: string
  sourceDir?: string
  outputFile?: string
}

interface ChannelDefinition {
  channel: string
  events: Map<string, Set<string>>
}

type ChannelDefinitionMap = Map<string, ChannelDefinition>
type MemberExpressionNode = BabelNode & {
  type: 'MemberExpression'
  object: BabelNode
  property: BabelNode
  computed?: boolean
}

const DEFAULT_SOURCE_DIR = 'app'
const DEFAULT_OUTPUT_FILE = '.guren/channels.gen.ts'
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])

export async function generateChannelTypes(
  options: GenerateChannelTypesOptions = {},
): Promise<{ outputPath: string; channels: string[] }> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const sourceDir = resolve(appRoot, options.sourceDir ?? DEFAULT_SOURCE_DIR)
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)

  const definitions = await collectChannelDefinitions(sourceDir)
  const channels = Array.from(definitions.keys()).sort((a, b) => a.localeCompare(b))
  const module = buildChannelModuleContent(definitions, {
    source: relative(appRoot, sourceDir) || DEFAULT_SOURCE_DIR,
  })

  const relativeTarget = relative(process.cwd(), outputFile) || outputFile
  const outputPath = await writeGeneratedFile(relativeTarget, module, { force: options.force })

  return { outputPath, channels }
}

export function buildChannelModuleContent(
  definitions: ChannelDefinitionMap,
  context: { source: string },
): string {
  const channels = Array.from(definitions.values()).sort((a, b) => a.channel.localeCompare(b.channel))
  const patternEntries = channels.map((definition) => `  '${esc(definition.channel)}',`).join('\n')

  const nameUnion = channels.length === 0
    ? 'never'
    : channels.map((definition) => patternToTypeLiteral(definition.channel)).join(' |\n  ')

  const eventMapEntries = channels.map((definition) => {
    const key = patternContainsParams(definition.channel)
      ? `[channel: ${patternToTypeLiteral(definition.channel)}]`
      : `'${esc(definition.channel)}'`
    return `{\n  ${key}: ${renderEventShape(definition.events)}\n}`
  })

  const channelEventsType = eventMapEntries.length === 0
    ? 'Record<string, Record<string, unknown>>'
    : eventMapEntries.join(' &\n')

  const channelEventManifestEntries = channels
    .map((definition) => {
      const events = Array.from(definition.events.keys()).sort((a, b) => a.localeCompare(b))
      const eventEntries = events.map((eventName) => `'${esc(eventName)}'`).join(', ')
      return `  '${esc(definition.channel)}': [${eventEntries}]`
    })
    .join(',\n')

  return `// Generated from ${context.source} — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

export const channelPatterns = [
${patternEntries || '  // No channels found'}
] as const

export type ChannelPattern = typeof channelPatterns[number]
export type ChannelName =
  ${nameUnion}

/**
 * Generated channel -> event contract map.
 * Event payloads default to unknown until event metadata codegen is introduced.
 */
export type ChannelEvents =
${channelEventsType}

/**
 * Runtime manifest of detected channel patterns and event names.
 */
export const channelEventManifest = {
${channelEventManifestEntries || '  // No channel events found'}
} as const
`
}

async function collectChannelDefinitions(directory: string): Promise<ChannelDefinitionMap> {
  const definitions: ChannelDefinitionMap = new Map()
  const files = await listSourceFiles(directory)

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8')
    extractDefinitionsFromSource(source, definitions, filePath)
  }

  return definitions
}

async function listSourceFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(fullPath))
      continue
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.'))
    if (!SOURCE_EXTENSIONS.has(extension)) continue
    files.push(fullPath)
  }

  return files
}

function extractDefinitionsFromSource(
  source: string,
  definitions: ChannelDefinitionMap,
  filePath?: string,
): void {
  // Plugins come from the extension rather than a fixed `typescript`+`jsx`
  // pair: JSX on a `.ts` file makes `<Type>value` cast syntax parse as an
  // unterminated JSX element, so a channel file using one was silently
  // contributing no channels.
  const ast = parseSourceFile(source, filePath)
  if (!ast) return

  walk(ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const callee = node.callee as BabelNode | undefined
    if (!callee || callee.type !== 'MemberExpression') return
    const member = callee as MemberExpressionNode
    if (member.computed) return
    if (member.property.type !== 'Identifier') return

    const methodName = member.property.name as string

    if (methodName === 'channel' || methodName === 'privateChannel' || methodName === 'presenceChannel') {
      const [patternArg] = (node.arguments as unknown[]) ?? []
      const pattern = getLiteralString(patternArg)
      if (!pattern) return

      const normalized = methodName === 'privateChannel'
        ? normalizePrivate(pattern)
        : methodName === 'presenceChannel'
          ? normalizePresence(pattern)
          : pattern
      ensureChannel(definitions, normalized)
      return
    }

    if (methodName === 'broadcast') {
      const channelFromChain = resolveChannelFromBroadcastChain(member.object)
      if (channelFromChain) {
        const [eventArg] = (node.arguments as unknown[]) ?? []
        const eventName = getLiteralString(eventArg)
        if (!eventName) return
        const [, payloadArg] = (node.arguments as unknown[]) ?? []
        const payloadType = renderPayloadType(payloadArg)
        addEventPayload(ensureChannel(definitions, channelFromChain), eventName, payloadType)
        return
      }

      const [channelArg, eventArg, payloadArg] = (node.arguments as unknown[]) ?? []
      const channelName = getLiteralString(channelArg)
      const eventName = getLiteralString(eventArg)
      if (!channelName || !eventName) return
      const payloadType = renderPayloadType(payloadArg)
      addEventPayload(ensureChannel(definitions, channelName), eventName, payloadType)
    }
  })
}

function resolveChannelFromBroadcastChain(value: BabelNode): string | null {
  if (value.type !== 'CallExpression') return null
  const callee = value.callee as BabelNode | undefined
  if (!callee || callee.type !== 'MemberExpression') return null
  const member = callee as MemberExpressionNode
  if (member.computed) return null
  if (member.property.type !== 'Identifier') return null

  const [firstArg] = (value.arguments as unknown[]) ?? []
  const channel = getLiteralString(firstArg)
  if (!channel) return null

  const methodName = member.property.name as string
  if (methodName === 'toChannel') return channel
  if (methodName === 'toPrivate') return normalizePrivate(channel)
  if (methodName === 'toPresence') return normalizePresence(channel)
  return null
}

function ensureChannel(definitions: ChannelDefinitionMap, channel: string): ChannelDefinition {
  const existing = definitions.get(channel)
  if (existing) return existing
  const created: ChannelDefinition = { channel, events: new Map() }
  definitions.set(channel, created)
  return created
}

function addEventPayload(definition: ChannelDefinition, eventName: string, payloadType: string): void {
  const payloads = definition.events.get(eventName) ?? new Set<string>()
  payloads.add(payloadType)
  definition.events.set(eventName, payloads)
}

function getLiteralString(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const node = value as { type?: string; value?: unknown; quasis?: Array<{ value?: { cooked?: string } }>; expressions?: unknown[] }

  if (node.type === 'StringLiteral' && typeof node.value === 'string') {
    return node.value
  }

  if (node.type === 'TemplateLiteral' && Array.isArray(node.quasis) && node.quasis.length === 1 && Array.isArray(node.expressions) && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked ?? null
  }

  return null
}

function normalizePrivate(value: string): string {
  return value.startsWith('private-') ? value : `private-${value}`
}

function normalizePresence(value: string): string {
  return value.startsWith('presence-') ? value : `presence-${value}`
}

function patternContainsParams(pattern: string): boolean {
  return /\{[^}]+\}/u.test(pattern)
}

function patternToTypeLiteral(pattern: string): string {
  if (!patternContainsParams(pattern)) {
    return `'${esc(pattern)}'`
  }

  const segments: string[] = []
  let cursor = 0
  const matcher = /\{[^}]+\}/gu
  let match = matcher.exec(pattern)
  while (match) {
    const staticPart = pattern.slice(cursor, match.index)
    if (staticPart.length > 0) segments.push(escapeTemplatePart(staticPart))
    segments.push('${string}')
    cursor = match.index + match[0].length
    match = matcher.exec(pattern)
  }
  const tail = pattern.slice(cursor)
  if (tail.length > 0) segments.push(escapeTemplatePart(tail))
  return `\`${segments.join('')}\``
}

function renderEventShape(events: Map<string, Set<string>>): string {
  const sorted = Array.from(events.entries()).sort(([left], [right]) => left.localeCompare(right))
  if (sorted.length === 0) {
    return 'Record<string, unknown>'
  }
  const entries = sorted
    .map(([eventName, payloadTypes]) => {
      const payload = renderPayloadUnion(payloadTypes)
      return `    '${esc(eventName)}': ${payload}`
    })
    .join('\n')
  return `{\n${entries}\n  }`
}

function renderPayloadUnion(payloads: Set<string>): string {
  const sorted = Array.from(payloads).sort((a, b) => a.localeCompare(b))
  if (sorted.length === 0) return 'unknown'
  if (sorted.length === 1) return sorted[0]
  return sorted.join(' | ')
}

function renderPayloadType(value: unknown): string {
  if (!value || typeof value !== 'object') return 'unknown'
  const node = value as BabelNode
  return normalizePayloadType(node)
}

function normalizePayloadType(node: BabelNode): string {
  switch (node.type) {
    case 'StringLiteral':
      return 'string'
    case 'NumericLiteral':
      return 'number'
    case 'BooleanLiteral':
      return 'boolean'
    case 'NullLiteral':
      return 'null'
    case 'ObjectExpression':
      return renderObjectPayloadType(node)
    case 'ArrayExpression':
      return renderArrayPayloadType(node)
    case 'TemplateLiteral':
      return 'string'
    default:
      return 'unknown'
  }
}

function renderObjectPayloadType(node: BabelNode): string {
  const properties = ((node as { properties?: unknown[] }).properties ?? []) as unknown[]
  const entries: string[] = []

  for (const property of properties) {
    if (!property || typeof property !== 'object') return 'unknown'
    const propNode = property as BabelNode
    if (propNode.type !== 'ObjectProperty') return 'unknown'
    if ((propNode as { computed?: boolean }).computed) return 'unknown'

    const key = renderObjectKey((propNode as { key?: unknown }).key)
    if (!key) return 'unknown'
    const valueNode = (propNode as { value?: unknown }).value
    if (!valueNode || typeof valueNode !== 'object') return 'unknown'
    const valueType = normalizePayloadType(valueNode as BabelNode)
    entries.push(`${key}: ${valueType}`)
  }

  if (entries.length === 0) return 'Record<string, never>'
  return `{ ${entries.join('; ')} }`
}

function renderArrayPayloadType(node: BabelNode): string {
  const elements = ((node as { elements?: unknown[] }).elements ?? []).filter(Boolean)
  if (elements.length === 0) return 'unknown[]'

  const elementTypes = new Set<string>()
  for (const element of elements) {
    if (!element || typeof element !== 'object') {
      elementTypes.add('unknown')
      continue
    }
    elementTypes.add(normalizePayloadType(element as BabelNode))
  }

  const union = renderPayloadUnion(elementTypes)
  return `(${union})[]`
}

function renderObjectKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const node = value as { type?: string; name?: string; value?: unknown }
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name
  if (node.type === 'StringLiteral' && typeof node.value === 'string') return `'${esc(node.value)}'`
  return null
}

function escapeTemplatePart(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/`/gu, '\\`').replace(/\$/gu, '\\$')
}

function esc(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
}
