import { resolve } from 'node:path'
import type { ClassDeclaration, ClassExpression, File } from '@babel/types'
import {
  discoverCommandFiles,
  excludeBarrelFiles,
  fileExists,
  classNameFromPath,
  toPosixRelative,
  moduleNameFor,
} from './discovery'
import { memberKeyName, unwrapTypeAssertion, walk } from './ast-walk'
import { camelCase, escapeRegExp, referencesIdentifier } from './utils'
import { ParseCache } from './parse-cache'
import { check, type CheckResult } from './check-result'

const CONSOLE_ENTRY = 'src/console.ts'

/**
 * A parsed entrypoint split into the local names it imports and its source
 * *outside* the imports. An import alone is not a use: a leftover
 * `import SendDigestCommand from …` next to an emptied `registerMany([])` is the
 * state these checks exist to catch. Re-exports count as body, since for a
 * module's `index.ts` they put a name on its public surface.
 */
interface EntrySource {
  /** Top-level statements minus `import` declarations. */
  body: string
  /** One entry per `import`: its specifier and the local names it binds. */
  imports: Array<{ specifier: string; names: string[] }>
}

async function readEntrySource(cache: ParseCache, absPath: string): Promise<EntrySource | null> {
  const parsed = await cache.get(absPath)
  if (!parsed) return null

  const body = parsed.ast.program.body
    .filter((node) => node.type !== 'ImportDeclaration')
    .map((node) => parsed.source.slice(node.start ?? 0, node.end ?? 0))
    .join('\n')

  const imports = parsed.ast.program.body
    .filter((node) => node.type === 'ImportDeclaration')
    .map((node) => ({
      specifier: node.source.value,
      names: node.specifiers.map((specifier) => specifier.local.name),
    }))

  return { body, imports }
}

/**
 * Whether the file could put a console command in front of a kernel — what keeps
 * a helper module living next to the commands out of the registration check
 * (#479). Exclusion needs positive evidence of *absence*, so a class extending
 * anything or carrying a `signature`/`handle` member counts, as does a re-export
 * with a source or a default-exported identifier or call. The superclass name is
 * not matched against `Command`: apps subclass their own bases. Unlike
 * `app-surface.ts`, "cannot tell" stays in the check — the cost is only a warn.
 */
function declaresCommand(ast: File): boolean {
  for (const node of ast.program.body) {
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      return true
    }
    // A default export counts unless its shape provably cannot surface a
    // command, so `export default new SendDigestCommand()` stays in and
    // `export default TABLES` does not.
    if (node.type === 'ExportDefaultDeclaration') {
      // Unwrapped: `export default { … } as const` is a TSAsExpression, absent
      // from the inert set, so the bare test would ask for a registration that
      // could never exist.
      const declaration = unwrapTypeAssertion(node.declaration)
      if (declaration.type !== 'ClassDeclaration' && !INERT_DEFAULT_EXPORTS.has(declaration.type)) {
        return true
      }
    }
  }

  let declares = false
  walk(ast.program, (node) => {
    if (declares) return false
    if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return
    const classNode = node as unknown as ClassDeclaration | ClassExpression
    declares =
      classNode.superClass != null ||
      classNode.body.body.some((member) => {
        if (!('key' in member)) return false
        const name = memberKeyName(member)
        return name === 'signature' || name === 'handle'
      })
  })
  return declares
}

/**
 * Default-export shapes that cannot evaluate to a registrable command class:
 * literals, object/array/template expressions, and plain functions. A
 * `ClassDeclaration` is absent on purpose — the class walk judges those by
 * their own evidence.
 */
const INERT_DEFAULT_EXPORTS = new Set([
  'StringLiteral',
  'NumericLiteral',
  'BooleanLiteral',
  'BigIntLiteral',
  'NullLiteral',
  'RegExpLiteral',
  'TemplateLiteral',
  'ObjectExpression',
  'ArrayExpression',
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'TSDeclareFunction',
])

/**
 * Local names `entry` imports from inside `modules/<moduleName>/`. The trailing
 * slash is load-bearing: a bare `modules/billing` also matches
 * `modules/billing-reports`, crediting one module's registration to another.
 */
function bindingsFromModule(entry: EntrySource, moduleName: string): string[] {
  return entry.imports
    .filter((imported) => imported.specifier.includes(`modules/${moduleName}/`))
    .flatMap((imported) => imported.names)
}

/**
 * Whether `entry` imports `name` from inside `modules/<moduleName>/`. Paired
 * with {@link referencesIdentifier} so one module's registration cannot cover
 * another's identically-named command — two modules may each ship an
 * `InvoiceCommand`.
 */
function importsNameFromModule(entry: EntrySource, moduleName: string, name: string): boolean {
  return entry.imports.some(
    (imported) => imported.specifier.includes(`modules/${moduleName}/`) && imported.names.includes(name),
  )
}

/** Whether `entry` registers `name`, having imported it from that module. */
function registersModuleCommand(entry: EntrySource | null, moduleName: string, name: string): boolean {
  return entry !== null && importsNameFromModule(entry, moduleName, name) && referencesIdentifier(entry.body, name)
}

/**
 * Whether `body` registers `binding`'s commands — `billingModule.commands`, or a
 * member chain ending there. The binding is resolved from the import first:
 * matching `.commands` anywhere would report a module as registered because a
 * *different* module's line is present.
 */
export function registersCommandsOf(body: string, bindings: string[]): boolean {
  return bindings.some((binding) =>
    new RegExp(
      `\\b${escapeRegExp(binding)}\\s*(?:\\.\\s*[\\w$]+\\s*)*(?:\\.\\s*commands\\b|\\[\\s*['"\`]commands['"\`]\\s*\\])`,
      'u',
    ).test(body),
  )
}

/**
 * The command files the registration check covers and `guren context` lists —
 * the one rule for "this file holds a command", so the two cannot disagree.
 *
 * An unparsable file cannot be shown to declare no command, so it stays in. That
 * path goes through `cache.read()`, not `get()`: the file *is* checked, so a
 * parse failure must not be recorded as "skipped and not checked".
 */
export async function discoverDeclaredCommandFiles(cwd: string, cache: ParseCache): Promise<string[]> {
  const discovered = excludeBarrelFiles(await discoverCommandFiles(cwd))
  const outcomes = await Promise.all(discovered.map((filePath) => cache.read(filePath)))
  return discovered.filter((_, index) => {
    const outcome = outcomes[index]!
    return outcome.status !== 'parsed' || declaresCommand(outcome.ast)
  })
}

/**
 * Verifies every class under `app/Console/Commands` is referenced by the console
 * entrypoint that would register it — `src/console.ts` for a project command,
 * `modules/<name>/index.ts` for a module's, each checked only against its own.
 * Detection is a name reference outside the entry's imports, hence `warn`, never
 * `fail`. Not filtered by `--changed`: the outcome turns on the *entrypoint's*
 * content, so filtering by command file would miss the edit that breaks it.
 */
export async function checkConsoleCommandRegistration(cwd: string, cache: ParseCache): Promise<CheckResult[]> {
  const commandFiles = await discoverDeclaredCommandFiles(cwd, cache)
  if (commandFiles.length === 0) return []

  const results: CheckResult[] = []
  // Read at most once, however many modules ask about it.
  let consoleEntry: EntrySource | null | undefined

  // Grouped by entrypoint so a missing one is reported once, not once per
  // command it would have registered.
  const byEntry = new Map<string, { moduleName: string | null; files: string[] }>()
  for (const filePath of commandFiles) {
    const moduleName = moduleNameFor(cwd, filePath)
    const entry = moduleName ? `modules/${moduleName}/index.ts` : CONSOLE_ENTRY
    const group = byEntry.get(entry) ?? { moduleName, files: [] }
    group.files.push(filePath)
    byEntry.set(entry, group)
  }

  for (const [entry, { moduleName, files }] of byEntry) {
    const names = files.map((file) => classNameFromPath(file))
    const entryKey = `console-entry:${entry}`
    const entryTitle = moduleName ? `${moduleName} console registration` : 'Console entrypoint'

    // Probed separately because `readEntrySource` returns null for a missing
    // file and an unparseable one alike, and those want different advice.
    if (!(await fileExists(cwd, entry))) {
      results.push(
        check(
          entryKey,
          entryTitle,
          'warn',
          `${names.join(', ')} ${names.length === 1 ? 'exists' : 'exist'} but there is no ${entry} to register `
          + `${names.length === 1 ? 'it' : 'them'} in.`,
          moduleName
            // Both hops, since neither alone leaves the commands runnable.
            ? `Create ${entry} with defineModule({ commands: [${names.join(', ')}] }), then add to `
              + `${CONSOLE_ENTRY}: kernel.registerMany(${camelCase(moduleName)}Module.commands)`
            : `Create ${entry} exporting a ConsoleKernel, then add: kernel.registerMany([${names.join(', ')}])`,
        ),
      )
      continue
    }

    const entrySource = await readEntrySource(cache, resolve(cwd, entry))

    if (entrySource === null) {
      results.push(
        check(
          entryKey,
          entryTitle,
          'warn',
          `${entry} could not be parsed, so ${names.join(', ')} cannot be verified as registered.`,
          `Check ${entry} for a syntax error.`,
        ),
      )
      continue
    }

    if (moduleName) {
      consoleEntry ??= await readEntrySource(cache, resolve(cwd, CONSOLE_ENTRY))
    }

    for (const filePath of files) {
      const name = classNameFromPath(filePath)
      // A module command also counts when the console entry imports and
      // registers it directly: the module's index may expose it through a barrel
      // that never spells the class name out.
      const registered
        = referencesIdentifier(entrySource.body, name)
        || (moduleName !== null && registersModuleCommand(consoleEntry ?? null, moduleName, name))
      const suggestion = moduleName
        ? `Import ${name} in ${entry} and add it to defineModule({ commands: [...] }).`
        : `Import ${name} in ${entry} and add it to kernel.registerMany([...]).`

      results.push(
        check(
          // Module-qualified: a root and a module command may share a name.
          `console-command:${moduleName ? `${moduleName}/` : ''}${name}`,
          `${name} registration`,
          registered ? 'pass' : 'warn',
          registered
            ? `${entry} references ${name} outside its imports.`
            : `${entry} never uses ${name} outside its imports, so no kernel receives it.`,
          registered ? undefined : suggestion,
          toPosixRelative(cwd, filePath),
        ),
      )
    }

    if (moduleName) {
      results.push(checkModuleCommandHop(consoleEntry ?? null, moduleName, names))
    }
  }

  return results
}

/**
 * Whether the project's console entrypoint registers `moduleName`'s commands —
 * the one hop `make:command` cannot patch, since
 * `kernel.registerMany(<module>.commands)` is a statement, not an array entry.
 * Both the wholesale `commands` array and the individual classes count.
 */
function checkModuleCommandHop(
  entry: EntrySource | null,
  moduleName: string,
  commandNames: string[],
): CheckResult {
  const binding = `${camelCase(moduleName)}Module`

  // Bindings come from the module's own import, so a *different* module's
  // `.commands` cannot satisfy this one. The conventional name stands in only
  // when that lookup finds nothing (an import through a path alias, say).
  const imported = entry === null ? [] : bindingsFromModule(entry, moduleName)
  const bindings = imported.length > 0 ? imported : [binding]
  const hopped
    = entry !== null
    && (registersCommandsOf(entry.body, bindings)
      || commandNames.every((name) => registersModuleCommand(entry, moduleName, name)))

  return check(
    `console-module-commands:${moduleName}`,
    `${moduleName} console commands`,
    hopped ? 'pass' : 'warn',
    hopped
      ? `${CONSOLE_ENTRY} registers ${moduleName}'s commands.`
      : `${CONSOLE_ENTRY} does not register ${moduleName}'s commands, so they never reach a kernel.`,
    hopped ? undefined : `Add to ${CONSOLE_ENTRY}: kernel.registerMany(${binding}.commands)`,
  )
}
