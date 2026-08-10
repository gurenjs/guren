import { resolve } from 'node:path'
import {
  discoverCommandFiles,
  excludeBarrelFiles,
  fileExists,
  classNameFromPath,
  toPosixRelative,
  moduleNameFor,
} from './discovery'
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
 * Not filtered by `--changed`, unlike `runCheck`'s file-scanning checks: what
 * decides the outcome is the *entrypoint's* content, so the edit that breaks
 * registration is usually to a file that isn't the command's. Filtering by
 * changed command files would report nothing for exactly that edit. The cost
 * is a directory walk over `app/Console/Commands` plus one read per entry.
 */
export async function checkConsoleCommandRegistration(cwd: string, cache: ParseCache): Promise<CheckResult[]> {
  const commandFiles = excludeBarrelFiles(await discoverCommandFiles(cwd))
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
