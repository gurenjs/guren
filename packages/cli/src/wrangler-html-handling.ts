/**
 * `"html_handling": "none"` in an app's `wrangler.jsonc`: what `guren doctor` reports
 * and `guren upgrade` adds. The Cloudflare build never rewrites that file, since it
 * holds the app's own ids, routes and bindings, so an app scaffolded before the key
 * existed keeps the platform default until a command the user invoked adds it.
 * The key is inserted as text and the result re-parsed, so comments and formatting stay.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const WRANGLER_CONFIG_FILE = 'wrangler.jsonc'
export const CF_CONFIG_FILE = 'cloudflare.config.ts'
/** Where the Cloudflare build stages `public/`, as the scaffolded config names it. */
export const STAGED_ASSETS_DIRECTORY = '.cloudflare/assets'
const HTML_HANDLING = 'none'
const PROPERTY = `"html_handling": "${HTML_HANDLING}"`

type RootHtmlHandling =
  | { kind: 'no-assets' }
  | { kind: 'set' }
  | { kind: 'other'; value: string }
  /**
   * `staged` is whether `assets.directory` is the build's. `patched` is present only
   * then, and only when the insertion re-parsed to the config plus the key.
   */
  | { kind: 'missing'; staged: boolean; patched?: string }

/** `environments` names each `env.<name>` whose own `assets` object lacks the key at `none`. */
export type ReadHtmlHandlingPlan = RootHtmlHandling & { environments: string[] }

export type HtmlHandlingPlan =
  | { kind: 'no-config' }
  /** The app deploys through `cloudflare.config.ts`, so `wrangler.jsonc` is not read. */
  | { kind: 'cf-backend' }
  | { kind: 'unreadable'; reason: string }
  | ReadHtmlHandlingPlan

interface JsoncToken {
  start: number
  end: number
  text: string
}

/** Every token outside whitespace and comments. A string literal is one token, as written. */
function tokenize(text: string): JsoncToken[] {
  const tokens: JsoncToken[] = []
  let index = 0

  while (index < text.length) {
    const char = text[index]!
    if (/\s/u.test(char)) {
      index += 1
    } else if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end === -1) throw new Error('a block comment is never closed')
      index = end + 2
    } else if (char === '"') {
      const start = index
      index += 1
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
      index = Math.min(index + 1, text.length)
      tokens.push({ start, end: index, text: text.slice(start, index) })
    } else if ('{}[],:'.includes(char)) {
      tokens.push({ start: index, end: index + 1, text: char })
      index += 1
    } else {
      const start = index
      while (index < text.length && !/[\s{}[\],:"/]/u.test(text[index]!)) index += 1
      // A lone `/` is not JSON; consumed so the scan ends, and JSON.parse reports it.
      if (index === start) index += 1
      tokens.push({ start, end: index, text: text.slice(start, index) })
    }
  }
  return tokens
}

/** Comments and trailing commas are all wrangler accepts beyond JSON. */
function parseTokens(tokens: JsoncToken[]): unknown {
  const kept = tokens.filter((token, index) => {
    const next = tokens[index + 1]?.text
    return !(token.text === ',' && (next === '}' || next === ']'))
  })
  return JSON.parse(kept.map((token) => token.text).join(' '))
}

/** The braces of the root object's `assets` value, as token indexes. */
function locateAssetsObject(tokens: JsoncToken[]): { open: number; close: number } | undefined {
  let depth = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!.text
    if (token === '{' || token === '[') depth += 1
    else if (token === '}' || token === ']') depth -= 1
    else if (depth === 1 && token === '"assets"' && tokens[index + 1]?.text === ':' && tokens[index + 2]?.text === '{') {
      const open = index + 2
      let nested = 0
      for (let close = open; close < tokens.length; close += 1) {
        const inner = tokens[close]!.text
        if (inner === '{' || inner === '[') nested += 1
        else if ((inner === '}' || inner === ']') && --nested === 0) return { open, close }
      }
      return undefined
    }
  }
  return undefined
}

function insertProperty(text: string, tokens: JsoncToken[]): string | undefined {
  const located = locateAssetsObject(tokens)
  if (!located) return undefined
  if (located.close === located.open + 1) return undefined
  const open = tokens[located.open]!
  const close = tokens[located.close]!

  const last = tokens[located.close - 1]!
  const body = text.slice(open.end, close.start)
  // Past a comment that follows the last property, so the new one starts after it.
  const tail = open.end + body.trimEnd().length
  const lineStart = text.lastIndexOf('\n', last.start) + 1
  const indent = /^[ \t]*/u.exec(text.slice(lineStart))![0]
  const property = body.includes('\n') ? `\n${indent}${PROPERTY}` : ` ${PROPERTY}`
  const comma = last.text === ',' ? '' : ','
  return text.slice(0, last.end) + comma + text.slice(last.end, tail) + property + text.slice(tail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStagedDirectory(directory: unknown): boolean {
  if (typeof directory !== 'string') return false
  return directory.replaceAll('\\', '/').replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '') === STAGED_ASSETS_DIRECTORY
}

/** Wrangler takes an environment's `assets` whole, in place of the root object. */
function environmentsWithoutNone(config: Record<string, unknown>): string[] {
  if (!isRecord(config.env)) return []
  return Object.entries(config.env)
    .filter(([, value]) => isRecord(value) && isRecord(value.assets) && value.assets.html_handling !== HTML_HANDLING)
    .map(([name]) => name)
}

function planRoot(text: string, tokens: JsoncToken[], config: Record<string, unknown>): RootHtmlHandling {
  const assets = config.assets
  if (!isRecord(assets)) return { kind: 'no-assets' }
  const value = assets.html_handling
  if (value === HTML_HANDLING) return { kind: 'set' }
  if (value !== undefined) return { kind: 'other', value: JSON.stringify(value) }
  if (!isStagedDirectory(assets.directory)) return { kind: 'missing', staged: false }

  const patched = insertProperty(text, tokens)
  if (patched === undefined) return { kind: 'missing', staged: true }
  const expected = { ...config, assets: { ...assets, html_handling: HTML_HANDLING } }
  try {
    if (JSON.stringify(parseTokens(tokenize(patched))) !== JSON.stringify(expected)) return { kind: 'missing', staged: true }
  } catch {
    return { kind: 'missing', staged: true }
  }
  return { kind: 'missing', staged: true, patched }
}

export function planHtmlHandling(text: string): ReadHtmlHandlingPlan | { kind: 'unreadable'; reason: string } {
  let tokens: JsoncToken[]
  let config: unknown
  try {
    tokens = tokenize(text)
    config = parseTokens(tokens)
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
  if (!isRecord(config)) return { kind: 'unreadable', reason: 'its root is not an object' }
  return { ...planRoot(text, tokens, config), environments: environmentsWithoutNone(config) }
}

/** The rule of `detectCloudflareBackend()` in `@guren/plugin-cloudflare`, which the CLI cannot import. */
async function deploysThroughCf(cwd: string): Promise<boolean> {
  if (!existsSync(resolve(cwd, CF_CONFIG_FILE))) return false
  try {
    const manifest: unknown = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'))
    if (!isRecord(manifest)) return false
    return [manifest.dependencies, manifest.devDependencies].some((group) => isRecord(group) && typeof group.cf === 'string')
  } catch {
    return false
  }
}

export async function planAppHtmlHandling(cwd: string): Promise<HtmlHandlingPlan> {
  if (await deploysThroughCf(cwd)) return { kind: 'cf-backend' }
  let text: string
  try {
    text = await readFile(resolve(cwd, WRANGLER_CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'no-config' }
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
  return planHtmlHandling(text)
}

/** Writes the key when the plan read now still calls for it; `false` when nothing was written. */
export async function addHtmlHandling(cwd: string): Promise<boolean> {
  const plan = await planAppHtmlHandling(cwd)
  if (plan.kind !== 'missing' || plan.patched === undefined) return false
  await writeFile(resolve(cwd, WRANGLER_CONFIG_FILE), plan.patched, 'utf8')
  return true
}
