/**
 * The MCP Skills extension (SEP-2640) on the App MCP endpoint: RFC 0042 §1.
 * Entries, digests and frontmatter are the SDK's (`SkillsExtension.load`); the
 * handlers are served from here because `attach()` takes an `McpServer` and the
 * endpoint is a low-level `Server` (see `./server`).
 */
import { ProtocolError, ProtocolErrorCode, type StandardSchemaV1 } from '@modelcontextprotocol/server'
import { memorySkillFiles, SkillsExtension, type Skill } from '@modelcontextprotocol/server/ext/skills'

export { SKILLS_EXTENSION_ID, SKILLS_GET_METHOD, SKILLS_LIST_METHOD } from '@modelcontextprotocol/server/ext/skills'

const SKILL_URI_SCHEME = 'skill://'
const SKILL_MANIFEST = 'SKILL.md'
const PAGE_SIZE = 100
const CURSOR_PREFIX = 'after:'
/**
 * Fixed (RFC 0042 §1.4): the endpoint is authenticated and the hints say
 * nothing about partitioning a cache by credential.
 */
const CACHE_FIELDS = { ttlMs: 0, cacheScope: 'private' } as const

/** What `guren codegen` writes to `.guren/mcp-skills.gen.ts`: paths under the skill namespace to contents. */
export interface McpSkillFilesModule {
  /** UTF-8 files. */
  files: Readonly<Record<string, string>>
  /** Every other file, base64. */
  binary: Readonly<Record<string, string>>
}

/** `mcpPlugin({ skills })`. */
export interface McpSkillsConfig {
  /** The generated module, as a module so every deploy bundler inlines it: `() => import('@/.guren/mcp-skills.gen')`. */
  files: () => McpSkillFilesModule | Promise<McpSkillFilesModule>
}

type SkillFileContents =
  | { uri: string; mimeType: string; text: string }
  | { uri: string; mimeType: string; blob: string }

/** What one request's server needs to serve skills: one snapshot, so an entry and the bytes behind it cannot disagree. */
export interface AppMcpSkills {
  /** Sorted by URI, as the SDK publishes them. */
  entries: readonly Skill[]
  byUri: ReadonlyMap<string, Skill>
  files: ReadonlyMap<string, SkillFileContents>
}

/**
 * The catalog, built once per plugin registration at boot. Undefined when the
 * app configured no skills or the module holds none, in which case the
 * endpoint advertises nothing new. A module of another shape, or a catalog
 * the SDK cannot build, fails the boot.
 */
export async function loadSkills(config: McpSkillsConfig | undefined): Promise<AppMcpSkills | undefined> {
  if (!config) return undefined

  let module: McpSkillFilesModule
  try {
    module = await config.files()
  } catch (cause) {
    throw new Error('[@guren/plugin-mcp] The skills module passed as `skills.files` could not be loaded.', { cause })
  }
  if (!isFileRecord(module?.files) || !isFileRecord(module?.binary)) {
    throw new Error(
      '[@guren/plugin-mcp] The skills module exports no `files` and `binary` objects, '
      + 'the shape `guren codegen` writes to .guren/mcp-skills.gen.ts.',
    )
  }

  // Copied before the catalog is built: its digests and the bytes served are one reading of the module.
  const contents = new Map<string, string | Uint8Array>(Object.entries(module.files))
  for (const [path, base64] of Object.entries(module.binary)) {
    if (contents.has(path)) {
      throw new Error(`[@guren/plugin-mcp] The skills module lists "${path}" as both text and binary.`)
    }
    try {
      contents.set(path, decodeBase64(base64))
    } catch {
      throw new Error(`[@guren/plugin-mcp] The skills module holds "${path}" as binary, and its content is not base64.`)
    }
  }
  // What codegen leaves once the last skill is removed: nothing to load, and nothing to warn about.
  if (contents.size === 0) return undefined
  const paths = [...contents.keys()]
  refuseUnnormalizedPaths(paths)
  refuseNestedSkills(paths)

  const catalog = await SkillsExtension.load(memorySkillFiles(Object.fromEntries(contents)), {
    onWarning: ({ path, message }) => {
      console.warn(`[@guren/plugin-mcp] Skill file "${path}": ${message}`)
    },
  })
  if (catalog.entries.length === 0) return undefined

  const byUri = new Map<string, Skill>()
  const files = new Map<string, SkillFileContents>()
  for (const entry of catalog.entries) {
    byUri.set(entry.uri, entry)
    // `load()` never publishes `"dynamic"`: every file of the skill is listed.
    for (const resource of Array.isArray(entry.resources) ? entry.resources : []) {
      const path = pathOfUri(resource.uri)
      const content = path === undefined ? undefined : contents.get(path)
      if (path === undefined || content === undefined) {
        throw new Error(`[@guren/plugin-mcp] The skill catalog publishes ${resource.uri}, which the skills module does not hold.`)
      }
      files.set(resource.uri, fileContents(resource.uri, mimeTypeOf(path), content))
    }
  }
  return { entries: catalog.entries, byUri, files }
}

/** Text when the bytes are lossless UTF-8 and base64 otherwise, the split the SDK's own skills server makes. */
function fileContents(uri: string, mimeType: string, content: string | Uint8Array): SkillFileContents {
  if (typeof content === 'string') return { uri, mimeType, text: content }
  const text = decodeUtf8(content)
  return text === undefined ? { uri, mimeType, blob: encodeBase64(content) } : { uri, mimeType, text }
}

/**
 * The SDK's file adapter drops empty and `.` segments and refuses `..`, so
 * such a key is published at a URI that leads back to no key of the module.
 */
function refuseUnnormalizedPaths(paths: readonly string[]): void {
  const odd = paths.find((path) => path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
  if (odd !== undefined) {
    throw new Error(
      `[@guren/plugin-mcp] The skills module holds the path ${JSON.stringify(odd)}. `
      + 'A path is relative to the skill namespace, with no empty, "." or ".." segment.',
    )
  }
}

/**
 * A `SKILL.md` below another skill's directory is that skill's file to the
 * extension, so it stays readable even when the catalog refuses it as a skill
 * of its own. RFC 0042 §1.1 supports no nesting; a root skill named like a
 * module that has skills is the same shape.
 */
function refuseNestedSkills(paths: readonly string[]): void {
  const manifests = paths.filter((path) => path.endsWith(`/${SKILL_MANIFEST}`))
  for (const manifest of manifests) {
    const directory = manifest.slice(0, -SKILL_MANIFEST.length)
    const nested = manifests.find((other) => other !== manifest && other.startsWith(directory))
    if (nested) {
      throw new Error(
        `[@guren/plugin-mcp] The skill "${nested}" sits inside the skill "${manifest}". Nested skills are not `
        + 'supported: move it out, or rename a root skill that carries the name of a module with skills.',
      )
    }
  }
}

/** `resources/list`: each `SKILL.md` and no supporting file, which a host reaches through the entry's manifest. */
export function listSkillResources(skills: AppMcpSkills) {
  return skills.entries.map((entry) => ({
    uri: entry.uri,
    name: entry.frontmatter.name,
    description: entry.frontmatter.description,
    mimeType: 'text/markdown',
  }))
}

/** `resources/read` for a `skill://` file the catalog publishes; undefined for any other URI. */
export function readSkillResource(uri: string, skills: AppMcpSkills): SkillFileContents | undefined {
  const canonical = canonicalUri(uri)
  return canonical === undefined ? undefined : skills.files.get(canonical)
}

/** `skills/list`: one page of entries in URI order, with an opaque cursor naming the last URI served. */
export function listSkills(skills: AppMcpSkills, cursor: string | undefined) {
  let start = 0
  if (cursor !== undefined) {
    const after = decodeCursor(cursor)
    if (after === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid cursor')
    start = skills.entries.findIndex((entry) => entry.uri > after)
    if (start === -1) start = skills.entries.length
  }
  const page = skills.entries.slice(start, start + PAGE_SIZE)
  const last = page.at(-1)
  return {
    skills: page,
    ...(start + PAGE_SIZE < skills.entries.length && last ? { nextCursor: encodeCursor(last.uri) } : {}),
    ...CACHE_FIELDS,
  }
}

/** `skills/get`: the entry whose `SKILL.md` is at `uri`; a URI naming no skill is the caller's mistake (`-32602`). */
export function getSkill(skills: AppMcpSkills, uri: string) {
  const canonical = canonicalUri(uri)
  const skill = canonical === undefined ? undefined : skills.byUri.get(canonical)
  if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`)
  return { skill, ...CACHE_FIELDS }
}

export const ListSkillsParams = paramsSchema<{ cursor?: string }>((params) => {
  if (params.cursor === undefined) return {}
  return typeof params.cursor === 'string' ? { cursor: params.cursor } : 'cursor must be a string'
})

export const GetSkillParams = paramsSchema<{ uri: string }>((params) =>
  typeof params.uri === 'string' ? { uri: params.uri } : 'uri must be a string',
)

/**
 * A Standard Schema over a request's params, which is what the SDK's custom-method
 * registration validates with. Hand-written so this package takes no schema
 * library of its own. `read` answers the parsed params, or a string naming the problem.
 */
function paramsSchema<T extends object>(read: (params: Record<string, unknown>) => T | string): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'guren',
      validate(value) {
        if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
          return { issues: [{ message: 'params must be an object' }] }
        }
        const result = read((value ?? {}) as Record<string, unknown>)
        return typeof result === 'string' ? { issues: [{ message: result }] } : { value: result }
      },
    },
  }
}

/** The WHATWG serialisation, which is the form the SDK publishes every URI in. */
function canonicalUri(uri: string): string | undefined {
  try {
    return new URL(uri).href
  } catch {
    return undefined
  }
}

/** The module key behind a published URI: its segments, percent-decoded. */
function pathOfUri(uri: string): string | undefined {
  if (!uri.startsWith(SKILL_URI_SCHEME)) return undefined
  try {
    return uri.slice(SKILL_URI_SCHEME.length).split('/').map((segment) => decodeURIComponent(segment)).join('/')
  } catch {
    return undefined
  }
}

// URIs are percent-encoded ASCII, so `btoa` needs no UTF-8 step.
function encodeCursor(uri: string): string {
  return btoa(CURSOR_PREFIX + uri).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeCursor(cursor: string): string | undefined {
  try {
    const decoded = decodeUtf8(decodeBase64(cursor.replaceAll('-', '+').replaceAll('_', '/')))
    return decoded?.startsWith(CURSOR_PREFIX) ? decoded.slice(CURSOR_PREFIX.length) : undefined
  } catch {
    return undefined
  }
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  // In chunks: one spread of a large file exceeds the engine's argument limit.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Undefined unless decoding loses nothing; a BOM is kept, so the text encodes back to the bytes that were hashed. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/** A plain object of strings: a `Map` or any other instance would otherwise read as a module with no files. */
function isFileRecord(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every((content) => typeof content === 'string')
}

/** Kept equal to the table the SDK's own skills server answers from (`mime.ts`), which it does not export. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  py: 'text/x-python',
  sh: 'application/x-sh',
  bash: 'application/x-sh',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  html: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
}

/** By the file's decoded name, never its URI: a percent-encoded extension matches nothing. */
function mimeTypeOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  return Object.hasOwn(MIME_BY_EXTENSION, extension) ? MIME_BY_EXTENSION[extension]! : 'application/octet-stream'
}
