import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import type { ClassMethod, File, Node, TSInterfaceBody, TSTypeElement } from '@babel/types'
import { GUREN_API_DIGEST } from '../src/api-digest'
import { memberKeyName } from '../src/ast-walk'
import { extractClassDeclaration } from '../src/model-parser'
import { ParseCache } from '../src/parse-cache'
import { specifierName } from '../src/route-registrar'

/**
 * Pins the API Tokens and Rate Limiting digest entries to the declarations they
 * summarize. Reads the sources rather than importing `@guren/core`, which
 * `packages/cli` resolves through the server's `dist/`: a stale build would pass.
 */
const source = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))
const SERVER_INDEX = source('server/src/index.ts')
const CORE_INDEX = source('core/src/index.ts')
const API_TOKEN = source('server/src/auth/api-token.ts')
const AUTH_MANAGER = source('server/src/auth/AuthManager.ts')
const RATE_LIMIT = source('server/src/http/middleware/rate-limit.ts')
const DATABASE_STORE = source('core/src/api-token-store.ts')

const cache = new ParseCache()

async function parse(path: string): Promise<File> {
  const parsed = await cache.get(path)
  if (!parsed) throw new Error(`Could not read or parse ${path}.`)
  return parsed.ast
}

function valueExports(ast: File): Set<string> {
  const names = new Set<string>()
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') continue
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type') names.add(specifierName(specifier.exported))
    }
    const declaration = node.declaration
    if (declaration && 'id' in declaration && declaration.id?.type === 'Identifier') names.add(declaration.id.name)
  }
  return names
}

function unwrapExport(node: Node): Node {
  return node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node
}

function interfaceBody(ast: File, name: string): TSInterfaceBody {
  for (const node of ast.program.body.map(unwrapExport)) {
    if (node.type === 'TSInterfaceDeclaration' && node.id.name === name) return node.body
  }
  throw new Error(`No interface ${name} in the parsed source.`)
}

/** Property name → optional. */
function members(elements: TSTypeElement[]): Map<string, boolean> {
  const result = new Map<string, boolean>()
  for (const element of elements) {
    if (element.type !== 'TSPropertySignature') continue
    const name = memberKeyName(element)
    if (name) result.set(name, element.optional === true)
  }
  return result
}

type Param = ClassMethod['params'][number]

/**
 * The digest's rendering rule: a plain parameter is its name, with `?` when
 * optional or defaulted; an object-typed one is `{ key, key? }`, naming every
 * required key of its type and any optional ones, each with its optionality.
 */
function checkParams(ast: File, label: string, params: Param[], rendered: string[]): void {
  expect(params.length, `${label}: parameter count`).toBe(rendered.length)
  params.forEach((param, index) => {
    const expected = rendered[index]
    const target = param.type === 'AssignmentPattern' ? param.left : param
    if (target.type !== 'Identifier') throw new Error(`${label}: parameter ${index} has no name`)
    const optional = param.type === 'AssignmentPattern' || target.optional === true

    if (!expected.startsWith('{')) {
      expect(expected, `${label}: parameter ${index}`).toBe(`${target.name}${optional ? '?' : ''}`)
      return
    }

    const annotation = target.typeAnnotation?.type === 'TSTypeAnnotation' ? target.typeAnnotation.typeAnnotation : null
    const declared =
      annotation?.type === 'TSTypeLiteral'
        ? members(annotation.members)
        : annotation?.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier'
          ? members(interfaceBody(ast, annotation.typeName.name).body)
          : null
    if (!declared) throw new Error(`${label}: parameter ${index} is not an object type the digest can list`)

    const keys = new Map(
      expected.replace(/^\{\s*|\s*\}$/g, '').split(/,\s*/).map((key) => [key.replace(/\?$/, ''), key.endsWith('?')]),
    )
    for (const [name, keyOptional] of keys) {
      expect(declared.has(name), `${label}: option ${name}`).toBe(true)
      expect(declared.get(name), `${label}: optionality of ${name}`).toBe(keyOptional)
    }
    for (const [name, memberOptional] of declared) {
      if (!memberOptional) expect(keys.has(name), `${label}: required option ${name}`).toBe(true)
    }
  })
}

function functionParams(ast: File, name: string): Param[] {
  for (const node of ast.program.body.map(unwrapExport)) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return node.params
  }
  throw new Error(`No function ${name} in the parsed source.`)
}

function classMethods(ast: File, name: string): Map<string, Param[]> {
  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (classDecl?.id?.name !== name) continue
    const methods = new Map<string, Param[]>()
    for (const member of classDecl.body.body) {
      if (member.type !== 'ClassMethod') continue
      const key = memberKeyName(member)
      if (key) methods.set(key, member.params)
    }
    return methods
  }
  throw new Error(`No class ${name} in the parsed source.`)
}

async function expectRendered(file: string, name: string, rendered: string[], prefix = ''): Promise<void> {
  const ast = await parse(file)
  const params = prefix === 'new ' ? (classMethods(ast, name).get('constructor') ?? []) : functionParams(ast, name)
  checkParams(ast, name, params, rendered)
  expect(GUREN_API_DIGEST).toContain(`${prefix}${name}(${rendered.join(', ')})`)
}

const SIGNATURES: Record<string, [file: string, rendered: string[]]> = {
  createApiToken: [API_TOKEN, ['store', '{ name, userId, abilities?, expiresIn?, tokenLength? }']],
  verifyApiToken: [API_TOKEN, ['plainTextToken', 'store', '{ updateLastUsed? }']],
  getUserApiTokens: [API_TOKEN, ['userId', 'store']],
  revokeApiToken: [API_TOKEN, ['id', 'store']],
  revokeAllApiTokens: [API_TOKEN, ['userId', 'store']],
  tokenCan: [API_TOKEN, ['token', 'ability']],
  tokenCanAll: [API_TOKEN, ['token', 'abilities']],
  tokenCanAny: [API_TOKEN, ['token', 'abilities']],
  createBearerTokenMiddleware: [
    API_TOKEN,
    ['{ store, loadUser?, abilities?, onUnauthorized?, onForbidden?, headerName?, updateLastUsed? }'],
  ],
  getApiToken: [API_TOKEN, ['ctx']],
  getApiTokenOrFail: [API_TOKEN, ['ctx']],
  createRateLimitMiddleware: [RATE_LIMIT, ['{ limit?, windowMs?, keyGenerator?, store?, keyPrefix?, skip?, trustProxy? }']],
}

describe('GUREN_API_DIGEST API token and rate limit entries', () => {
  it('names only values @guren/core exports', async () => {
    const [server, core] = await Promise.all([parse(SERVER_INDEX), parse(CORE_INDEX)])
    const serverExports = valueExports(server)
    for (const name of [...Object.keys(SIGNATURES), 'MemoryApiTokenStore']) {
      expect(serverExports.has(name), `@guren/server exports ${name}`).toBe(true)
    }

    const reexportsServer = core.program.body.some(
      (node) => node.type === 'ExportAllDeclaration' && node.source.value === '@guren/server',
    )
    expect(reexportsServer).toBe(true)
    expect(valueExports(core).has('DatabaseApiTokenStore')).toBe(true)
  })

  for (const [name, [file, rendered]] of Object.entries(SIGNATURES)) {
    it(`renders ${name} with its declared parameters`, () => expectRendered(file, name, rendered))
  }

  it('renders the token stores with their declared constructors', async () => {
    expect(classMethods(await parse(API_TOKEN), 'MemoryApiTokenStore').has('constructor')).toBe(false)
    expect(GUREN_API_DIGEST).toContain('new MemoryApiTokenStore()')

    await expectRendered(DATABASE_STORE, 'DatabaseApiTokenStore', ['table', '{ abilitiesMode? }'], 'new ')
    expect(classMethods(await parse(DATABASE_STORE), 'DatabaseApiTokenStore').has('deleteExpired')).toBe(true)
    expect(GUREN_API_DIGEST).toContain('store.deleteExpired()')
  })

  it('renders app.auth.useTokens with the store first', async () => {
    const [first] = classMethods(await parse(AUTH_MANAGER), 'AuthManager').get('useTokens') ?? []
    expect(first?.type === 'Identifier' ? first.name : undefined).toBe('store')
    expect(GUREN_API_DIGEST).toContain('app.auth.useTokens(store)')
  })

  it('lists every ApiToken field as a table column', async () => {
    for (const field of members(interfaceBody(await parse(API_TOKEN), 'ApiToken').body).keys()) {
      expect(GUREN_API_DIGEST).toContain(`\`${field}\``)
    }
  })
})
