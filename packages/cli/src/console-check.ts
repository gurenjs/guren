import { resolve } from 'node:path'
import type { ClassDeclaration, ClassExpression, File, Node } from '@babel/types'
import {
  discoverCommandFiles,
  excludeBarrelFiles,
  fileExists,
  classNameFromPath,
  toPosixRelative,
  moduleNameFor,
} from './discovery'
import { walk } from './ast-walk'
import { memberKeyName } from './model-parser'
import { camelCase, escapeRegExp, referencesIdentifier } from './utils'
import { ParseCache } from './parse-cache'
import { check, type CheckResult } from './check-result'

const CONSOLE_ENTRY = 'src/console.ts'

/**
 * A parsed entrypoint split into the two halves a registration check needs:
 * the local names it imports from a given path, and its source *outside* the
 * import statements.
 *
 * The split matters because an import alone is not a use: a leftover
 * `import SendDigestCommand from ...` next to an emptied `registerMany([])`
 * is exactly the state these checks exist to catch.
 *
 * Re-exports (`export { X } from './x'`) count as body, not imports: for a
 * module's `index.ts` they put a name on the module's public surface, which
 * is the thing being asked about.
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
 * Whether the file could put a console command in front of a kernel. This is
 * what keeps a constants or helper module living next to the commands out of
 * the registration check: it surfaces no command, so there is nothing to hand
 * to `registerMany()` and the warning it would get could never be resolved.
 *
 * Exclusion needs positive evidence of *absence*, so anything that could
 * surface a command counts:
 * - a class — declaration or expression, at any depth — extending another
 *   class or carrying the `make:command` surface (a `signature` or `handle`
 *   member). The superclass name is deliberately not matched against
 *   `Command`: apps subclass their own bases, and an aliased import defeats
 *   a name check. The cost is that a colocated `extends Error` helper still
 *   warns — accepted, because the reverse mistake (a real command with an
 *   unrecognizable base silently leaving the check) reports nothing at all.
 * - a re-export with a source (`export { X } from './impl'`) or a
 *   default-exported identifier or call — shims and factories surface
 *   commands declared elsewhere, and the old path-based check covered them.
 *
 * What remains excluded is a module of imports, constants, functions, types,
 * and local named exports — the shape issue #479 reported.
 *
 * Note the fail direction is the opposite of `app-surface.ts`, deliberately:
 * there, "cannot tell" answers false because the cost of a wrong yes is
 * refusing commands that would have worked; here the cost is only a `warn`,
 * so "cannot tell" stays in the check.
 */
function declaresCommand(ast: File): boolean {
  for (const node of ast.program.body) {
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      return true
    }
    if (
      node.type === 'ExportDefaultDeclaration' &&
      (node.declaration.type === 'Identifier' || node.declaration.type === 'CallExpression')
    ) {
      return true
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
        const name = memberKeyName(member as { computed?: boolean | null; key: Node })
        return name === 'signature' || name === 'handle'
      })
    if (declares) return false
  })
  return declares
}

/**
 * Local names `entry` imports from inside `modules/<moduleName>/`. The
 * trailing slash is load-bearing: a bare `modules/billing` substring also
 * matches `modules/billing-reports`, which would credit one module's
 * registration to another.
 */
function bindingsFromModule(entry: EntrySource, moduleName: string): string[] {
  return entry.imports
    .filter((imported) => imported.specifier.includes(`modules/${moduleName}/`))
    .flatMap((imported) => imported.names)
}

/**
 * Whether `entry` imports `name` from inside `modules/<moduleName>/`. Pairing
 * this with {@link referencesIdentifier} is what stops one module's registration
 * from covering another's identically-named command — two modules may each
 * ship an `InvoiceCommand`, and the bare name cannot tell them apart.
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
 * Whether `body` registers `binding`'s commands — `billingModule.commands`,
 * or a member chain ending there for a namespace import.
 *
 * Resolving the binding from the import first is what keeps this honest with
 * more than one module in play: matching `.commands` anywhere would report a
 * module as registered because a *different* module's line is present.
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
 * the one rule for "this file holds a command", shared so the two commands
 * cannot disagree about what a helper module is. Discovery walks the
 * directories; {@link declaresCommand} judges the contents.
 *
 * A file that fails to parse (or read) cannot be shown to declare no command,
 * so it stays in rather than silently dropping out. That path goes through
 * `cache.read()`, not `get()`: an AST is optional here, so a parse failure
 * must not be recorded as "skipped and not checked" — the file *is* checked,
 * conservatively.
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
 * Verifies every class under `app/Console/Commands` is referenced by the
 * console entrypoint that would register it. Nothing scans that directory at
 * runtime — a `ConsoleKernel` only knows the commands it was handed, so a
 * generated-but-unregistered command is dead code that no other signal
 * reports. `make:command` performs this wiring, so a warning here means a
 * command was written or moved by hand.
 *
 * Registration takes two shapes, and each command is only checked against
 * its own:
 * - a project-level command must be named by `src/console.ts`
 *   (`kernel.registerMany([SendDigestCommand])`)
 * - a module's command must be named by `modules/<name>/index.ts`
 *   (`defineModule({ commands: [...] })`), the module's public surface
 *
 * Detection is a name reference outside the entry's imports (see
 * {@link EntrySource}), and nothing more: it says the entrypoint uses the
 * class, not that the kernel ends up with it. `warn`, never `fail`, since a
 * name reference is not proof of registration in the other direction either.
 *
 * Only files that {@link declaresCommand} — a helper module beside the
 * commands has no command to register, so demanding a registration for it
 * produces a warning that can never be satisfied.
 *
 * Not filtered by `--changed`, unlike `runCheck`'s file-scanning checks: what
 * decides the outcome is the *entrypoint's* content, so the edit that breaks
 * registration is usually to a file that isn't the command's. Filtering by
 * changed command files would report nothing for exactly that edit. The cost
 * is a directory walk over `app/Console/Commands` plus one parse per command
 * file and per entrypoint.
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
      // A module command also counts when the console entry imports it from
      // that module and registers it directly — the module's index may expose
      // it through a barrel (`export * from './commands.js'`) that never spells
      // the class name out.
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
 * Whether the project's console entrypoint registers `moduleName`'s commands
 * — the one hop `make:command` cannot patch, since
 * `kernel.registerMany(<module>.commands)` is a statement rather than an entry
 * in an existing array.
 *
 * Two shapes count, because both leave the commands runnable: the module's
 * `commands` array registered wholesale, or the individual classes registered
 * by name (what a project predating the `commands` field does).
 */
function checkModuleCommandHop(
  entry: EntrySource | null,
  moduleName: string,
  commandNames: string[],
): CheckResult {
  const binding = `${camelCase(moduleName)}Module`

  // Bindings come from the module's own import, so that `.commands` belonging
  // to a *different* module cannot satisfy this one. Only when that lookup
  // finds nothing — an import through a path alias, say — does the
  // conventional name stand in; adding it unconditionally could only
  // manufacture a pass.
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
