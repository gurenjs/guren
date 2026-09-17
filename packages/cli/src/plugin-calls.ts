/**
 * The one reading of a first-party plugin's factory call in app source:
 * `mcpPlugin({ … })`, `aiPlugin({ … })`. Calls are found through the local
 * aliases of the package export, never by a bare name, and each reports which
 * option keys it carries literally. `guren check`'s approval-queue and
 * audit-trail rules both read it.
 */
import { relative, resolve } from 'node:path'
import type { CallExpression, File } from '@babel/types'
import { memberKeyName, objectLiteral, walk } from './ast-walk'
import { collectFiles, listAppRoots, NON_SOURCE_DIR_NAMES } from './discovery'
import type { ParseCache, ParsedFile } from './parse-cache'
import { resolveAppEntry } from './provider-registrar'

export interface PluginExport {
  specifier: string
  exportName: string
}

export const MCP_PLUGIN_EXPORT: PluginExport = { specifier: '@guren/plugin-mcp', exportName: 'mcpPlugin' }

export interface PluginCall {
  relPath: string
  /** Option keys written literally in the call's object argument. */
  keys: ReadonlySet<string>
  /**
   * Whether the absence of a key is evidence: false for a spread in the
   * options or a non-literal argument, where a key may still arrive.
   */
  complete: boolean
}

/** Local names `exportName` is imported under from `specifier` in one file. */
export function importedLocals(ast: File, target: PluginExport): Set<string> {
  return importBindings(ast, target).locals
}

/** Namespace bindings too (`import * as ai`), whose member calls read as the export. */
function importBindings(ast: File, target: PluginExport): { locals: Set<string>; namespaces: Set<string> } {
  const locals = new Set<string>()
  const namespaces = new Set<string>()
  for (const declaration of ast.program.body) {
    if (declaration.type !== 'ImportDeclaration') continue
    if (declaration.source.value !== target.specifier) continue
    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') {
        namespaces.add(specifier.local.name)
        continue
      }
      if (specifier.type !== 'ImportSpecifier') continue
      const imported =
        specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      if (imported === target.exportName) locals.add(specifier.local.name)
    }
  }
  return { locals, namespaces }
}

function readCalls(parsed: ParsedFile, target: PluginExport, relPath: string): PluginCall[] {
  const { locals, namespaces } = importBindings(parsed.ast, target)
  if (locals.size === 0 && namespaces.size === 0) return []

  const calls: PluginCall[] = []
  walk(parsed.ast.program, (node) => {
    if (node.type !== 'CallExpression') return
    const call = node as unknown as CallExpression
    if (!callsTarget(call, locals, namespaces, target.exportName)) return

    const argument = call.arguments[0]
    if (!argument) {
      calls.push({ relPath, keys: new Set(), complete: true })
      return
    }
    // Read through transparent wrapping: a bare shape test reads `{ … } satisfies
    // McpPluginOptions` as unreadable, which silences every rule built on this.
    const options = objectLiteral(argument as never)
    if (!options) {
      calls.push({ relPath, keys: new Set(), complete: false })
      return
    }

    const keys = new Set<string>()
    let complete = true
    for (const property of options.properties) {
      if (property.type === 'SpreadElement') {
        complete = false
        continue
      }
      const key = memberKeyName(property)
      if (key === undefined) complete = false
      else keys.add(key)
    }
    calls.push({ relPath, keys, complete })
  })
  return calls
}

/**
 * Every call to the export in the app's `config/`, `src/` and `app/` trees (module
 * roots included) and the app entry, or with `project`, in every source file
 * outside dependency and build directories. Test files are skipped: a plugin a
 * test constructs is not the one the app registers.
 */
export async function scanPluginCalls(
  cwd: string,
  cache: ParseCache,
  target: PluginExport,
  scope: 'app' | 'project' = 'app',
): Promise<PluginCall[]> {
  const files = (scope === 'project' ? await collectFiles(cwd, undefined, NON_SOURCE_DIR_NAMES) : await appFiles(cwd))
    .filter((file) => !/\.test\.[jt]sx?$/.test(file))

  const calls: PluginCall[] = []
  for (const filePath of files) {
    // String pre-filter before any parse: almost no source mentions the plugin.
    const source = await cache.source(filePath)
    if (!source || !source.includes(target.exportName)) continue
    const parsed = await cache.get(filePath)
    if (!parsed) continue
    calls.push(...readCalls(parsed, target, relative(cwd, filePath).replace(/\\/g, '/')))
  }
  return calls
}

async function appFiles(cwd: string): Promise<string[]> {
  const roots = await listAppRoots(cwd)
  const groups = await Promise.all(
    roots.flatMap((root) => ['config', 'src', 'app'].map((dir) => collectFiles(resolve(root.dir, dir)))),
  )
  const entry = await resolveAppEntry(cwd)
  return [...new Set([...groups.flat(), ...(entry ? [resolve(cwd, entry)] : [])])]
}

/** `aiPlugin(…)` through a named import, or `ai.aiPlugin(…)` through a namespace one. */
function callsTarget(
  call: CallExpression,
  locals: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  exportName: string,
): boolean {
  const { callee } = call
  if (callee.type === 'Identifier') return locals.has(callee.name)
  return (
    callee.type === 'MemberExpression'
    && !callee.computed
    && callee.object.type === 'Identifier'
    && namespaces.has(callee.object.name)
    && callee.property.type === 'Identifier'
    && callee.property.name === exportName
  )
}
