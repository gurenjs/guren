import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import readline from 'node:readline'
import { inspect } from 'node:util'
import { consola } from 'consola'
import { defineCommand } from 'citty'
import { parse } from '@babel/parser'
import {
  bootstrapApplication,
  ensureApplicationBooted,
  importFirstAvailableApplicationModule,
  isRecord,
  resolveMainEntry,
  type MaybeApplication,
} from '../runtime'

type AsyncEvalFunction = (code: string) => Promise<unknown>
type AsyncFunctionConstructor = new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>
const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor
const evaluateUserInput = new AsyncFunctionCtor('code', 'return await eval(code);') as unknown as AsyncEvalFunction

type ReadlineWithHistory = readline.Interface & {
  history: string[]
  historySize?: number
}

const HISTORY_FILENAME = '.guren_console_history'
const MODEL_FILE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])

type TransformedCode = {
  code: string
  assigned: string[]
}

function transformUserCode(raw: string): TransformedCode {
  try {
    const ast = parse(raw, {
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      ranges: true,
      plugins: ['topLevelAwait', 'typescript'],
    }) as unknown as {
      program: {
        body: Array<{
          type: string
          start: number | null | undefined
          end: number | null | undefined
          declarations?: Array<{
            id: { type: string; name?: string }
            init?: { start?: number | null; end?: number | null }
          }>
        }>
      }
    }

    const assigned: string[] = []
    const pieces: string[] = []
    let lastIndex = 0

    for (const node of ast.program.body) {
      const { type, start, end } = node
      if (start == null || end == null) {
        continue
      }

      if (type !== 'VariableDeclaration' || !Array.isArray(node.declarations) || node.declarations.length === 0) {
        continue
      }

      const declarations = node.declarations
      const transformedParts: string[] = []
      let transformable = true

      for (const declarator of declarations) {
        const identifier = declarator.id
        if (!identifier || identifier.type !== 'Identifier' || !identifier.name) {
          transformable = false
          break
        }

        const init = declarator.init
        const initialValue = init && init.start != null && init.end != null ? raw.slice(init.start, init.end) : 'undefined'
        transformedParts.push(`globalThis.${identifier.name} = ${initialValue};`)
        assigned.push(identifier.name)
      }

      if (!transformable) {
        continue
      }

      pieces.push(raw.slice(lastIndex, start))
      pieces.push(transformedParts.join('\n'))
      lastIndex = end
    }

    pieces.push(raw.slice(lastIndex))
    return { code: pieces.join(''), assigned }
  } catch (error) {
    consola.debug('Failed to transform console input:', error)
    return { code: raw, assigned: [] }
  }
}

async function executeUserCode(code: string): Promise<unknown> {
  const { code: transformed } = transformUserCode(code)
  return evaluateUserInput.call(globalThis, transformed)
}

async function loadHistoryFile(rl: ReadlineWithHistory, historyPath: string): Promise<void> {
  try {
    const raw = await readFile(historyPath, 'utf8')
    const entries = raw.split('\n').filter(Boolean)
    rl.history = entries.reverse()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      consola.debug(`Failed to read console history at ${historyPath}:`, error)
    }
  }
}

async function saveHistoryFile(rl: ReadlineWithHistory, historyPath: string): Promise<void> {
  const size = rl.historySize ?? 1000
  const entries = rl.history.slice(0, size).reverse()
  const data = entries.join('\n')
  await writeFile(historyPath, data ? `${data}\n` : '', 'utf8')
}

function formatResult(value: unknown): void {
  if (value === undefined) {
    return
  }

  const useColors = process.stdout.isTTY
  const output = inspect(value, { depth: 4, colors: useColors, breakLength: 80 })
  process.stdout.write(`${output}\n`)
}

function isRecoverableError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes('unexpected end of input') || message.includes('unexpected end of string') || message.includes('missing ) after argument list') || message.includes('missing ] after element list')
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

async function collectModelFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue
    }

    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectModelFiles(absolute))
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const extension = extname(entry.name)
    if (!MODEL_FILE_EXTENSIONS.has(extension) || entry.name.endsWith('.d.ts')) {
      continue
    }

    files.push(absolute)
  }

  return files
}

async function findModelsDirectory(entryPath: string): Promise<string | undefined> {
  let current = dirname(entryPath)

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(current, 'app/Models')
    if (await isDirectory(candidate)) {
      return candidate
    }

    const parent = dirname(current)
    if (parent === current) {
      break
    }

    current = parent
  }

  return undefined
}

function createModelLoader(entryPath: string) {
  const context = globalThis as Record<string, unknown>
  let resolvedModelsDir: string | null | undefined

  async function ensureModelsDirectory(): Promise<string | undefined> {
    if (resolvedModelsDir === undefined) {
      resolvedModelsDir = await findModelsDirectory(entryPath) ?? null
    }

    return resolvedModelsDir ?? undefined
  }

  async function loadModels(): Promise<string[]> {
    const dir = await ensureModelsDirectory()
    if (!dir) {
      return []
    }

    const ModelCtor = context.Model as (Function & { isPrototypeOf?: (value: unknown) => boolean }) | undefined
    if (typeof ModelCtor !== 'function') {
      return []
    }

    const discovered: string[] = []
    const files = await collectModelFiles(dir)

    for (const file of files) {
      try {
        const moduleExports = (await import(pathToFileURL(file).href)) as Record<string, unknown>

        for (const [rawName, exportValue] of Object.entries(moduleExports)) {
          if (typeof exportValue !== 'function') {
            continue
          }

          const candidatePrototype = exportValue.prototype
          const isModelExport = candidatePrototype && typeof ModelCtor.isPrototypeOf === 'function'
            ? ModelCtor.isPrototypeOf(exportValue)
            : candidatePrototype instanceof ModelCtor

          if (!candidatePrototype || !isModelExport) {
            continue
          }

          const exportName = rawName === 'default' ? exportValue.name || 'default' : rawName
          if (!exportName) {
            continue
          }

          context[exportName] = exportValue
          discovered.push(exportName)
        }
      } catch (error) {
        consola.warn(`Failed to load models from ${file}:`, error)
      }
    }

    return discovered
  }

  return {
    load: loadModels,
  }
}

async function attachFrameworkHelpers(context: Record<string, unknown>): Promise<string[]> {
  const provided: string[] = []

  try {
    const serverExports = await import('@guren/server')

    if (Object.prototype.hasOwnProperty.call(serverExports, 'Route')) {
      context.Route = serverExports.Route
      provided.push('Route')
    }

    if (Object.prototype.hasOwnProperty.call(serverExports, 'Controller')) {
      context.Controller = serverExports.Controller
      provided.push('Controller')
    }
  } catch (error) {
    consola.debug('Unable to load @guren/server helpers:', error)
  }

  try {
    const ormExports = await import('@guren/orm')

    if (Object.prototype.hasOwnProperty.call(ormExports, 'Model')) {
      context.Model = ormExports.Model
      provided.push('Model')
    }
  } catch (error) {
    consola.debug('Unable to load @guren/orm helpers:', error)
  }

  return provided
}

async function attachDatabaseHelpers(context: Record<string, unknown>, onExitTasks: Array<() => Promise<void>>): Promise<string[]> {
  const provided: string[] = []
  const result = await importFirstAvailableApplicationModule([
    'config/database.ts',
    'config/database.mts',
    'config/database.js',
    'config/database.mjs',
  ])

  if (!result) {
    return provided
  }

  const databaseExports = result.module

  const getDatabase = databaseExports.getDatabase
  if (typeof getDatabase === 'function') {
    context.getDatabase = getDatabase
    provided.push('getDatabase')

    try {
      context.db = await getDatabase()
      provided.push('db')
      consola.success('Database connection is available as "db".')
    } catch (error) {
      consola.warn(`Failed to initialize database from ${result.path}:`, error)
    }
  }

  const closeDatabase = databaseExports.closeDatabase
  if (typeof closeDatabase === 'function') {
    context.closeDatabase = closeDatabase
    provided.push('closeDatabase')
    onExitTasks.push(async () => {
      try {
        await closeDatabase()
      } catch (error) {
        consola.warn('Error while closing database connection:', error)
      }
    })
  }

  const configureOrm = databaseExports.configureOrm
  if (typeof configureOrm === 'function') {
    context.configureOrm = configureOrm
    provided.push('configureOrm')
  }

  const seedDatabase = databaseExports.seedDatabase
  if (typeof seedDatabase === 'function') {
    context.seedDatabase = seedDatabase
    provided.push('seedDatabase')
  }

  return provided
}

async function populateReplContext(app: MaybeApplication, onExitTasks: Array<() => Promise<void>>): Promise<Set<string>> {
  const context = globalThis as Record<string, unknown>
  const provided = new Set<string>()

  context.app = app
  provided.add('app')

  const unknownApp = app as unknown
  if (isRecord(unknownApp) && 'auth' in unknownApp) {
    context.auth = (unknownApp as Record<string, unknown>).auth
    provided.add('auth')
  }

  for (const name of await attachFrameworkHelpers(context)) {
    provided.add(name)
  }

  for (const name of await attachDatabaseHelpers(context, onExitTasks)) {
    provided.add(name)
  }

  return provided
}

export const consoleCommand = defineCommand({
  meta: {
    name: 'console',
    description: 'Start an interactive Guren console.',
  },
  async run() {
    let entry: string
    try {
      entry = await resolveMainEntry()
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
      return
    }

    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>
    } catch (error) {
      consola.error(`Failed to import application entry (${entry}):`, error)
      process.exit(1)
      return
    }

    let app: MaybeApplication
    try {
      app = await bootstrapApplication(mod)
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
      return
    }

    await ensureApplicationBooted(app, mod)

    consola.info('Booted application. Launching console (press Ctrl+D to exit)...')

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'guren> ',
      terminal: process.stdin.isTTY,
      historySize: 1000,
    }) as ReadlineWithHistory

    const historyPath = resolve(process.cwd(), HISTORY_FILENAME)

    await loadHistoryFile(rl, historyPath)

    const onExitTasks: Array<() => Promise<void>> = []
    const globals = await populateReplContext(app, onExitTasks)

    const modelLoader = createModelLoader(entry)
    const initialModels = await modelLoader.load()
    for (const name of initialModels) {
      globals.add(name)
    }

    const context = globalThis as Record<string, unknown>
    context.reloadModels = async (): Promise<string[]> => {
      const names = await modelLoader.load()
      if (names.length > 0) {
        consola.success(`Reloaded models: ${names.join(', ')}.`)
      } else {
        consola.info('No models discovered under app/Models.')
      }
      return names
    }
    globals.add('reloadModels')

    const names = [...globals].sort((a, b) => a.localeCompare(b))
    consola.success(`Console ready. Injected globals: ${names.join(', ')}.`)

    let buffer = ''
    let continuing = false

    rl.prompt()

    rl.on('line', async (line) => {
      buffer = continuing ? `${buffer}\n${line}` : line
      continuing = false

      const trimmed = buffer.trim()
      if (!trimmed) {
        buffer = ''
        rl.setPrompt('guren> ')
        rl.prompt()
        return
      }

      if (trimmed === '.exit' || trimmed === 'exit') {
        rl.close()
        return
      }

      try {
        const result = await executeUserCode(buffer)
        formatResult(result)
        buffer = ''
        rl.setPrompt('guren> ')
      } catch (error) {
        if (isRecoverableError(error)) {
          continuing = true
          rl.setPrompt('.... ')
          rl.prompt()
          return
        }

        consola.error(error)
        buffer = ''
        rl.setPrompt('guren> ')
      }

      rl.prompt()
    })

    rl.on('SIGINT', () => {
      if (buffer.length > 0) {
        buffer = ''
        continuing = false
        process.stdout.write('\n')
        rl.setPrompt('guren> ')
        rl.prompt()
        return
      }

      rl.close()
    })

    rl.on('close', () => {
      void (async () => {
        try {
          await saveHistoryFile(rl, historyPath)
        } catch (error) {
          consola.debug(`Failed to persist console history at ${historyPath}:`, error)
        }

        for (const task of onExitTasks) {
          try {
            await task()
          } catch (error) {
            consola.warn('Error during console shutdown cleanup:', error)
          }
        }
      })().finally(() => {
        process.stdout.write('\n')
        process.exit(0)
      })
    })
  },
})
