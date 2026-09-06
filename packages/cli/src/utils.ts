import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep as pathSep } from 'node:path'

export interface WriterOptions {
  force?: boolean
  /**
   * Project root a generator's relative output path resolves against; defaults to
   * `process.cwd()`. Callers that are not a one-shot process name the directory instead
   * of steering into it — `chdir` is per-process state, so it would race concurrent
   * `guren mcp` requests and relocate every other Bun test file in the same process.
   */
  cwd?: string
  /**
   * When set (via `--module <name>`), prefixes a generator's output directory with
   * `modules/<kebab-case root>/`. Normalized to kebab-case the same way `make:module`
   * derives its directory name, so both spellings target the same directory.
   */
  root?: string
}

export type ScaffoldNames = {
  rawName: string
  className: string
  fileName: string
  normalizedName: string
}

export interface ScaffoldConfig {
  dir: string
  suffix?: string
  extension?: string
  fileName?: (names: ScaffoldNames) => string
  template: (names: ScaffoldNames) => string
}

/** Spawn a command with inherited stdio and resolve when it exits cleanly. */
export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', (error) => {
      rejectPromise(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
}

/**
 * Throws unless `relativePath` stays under the project root. Scaffold names are not all
 * developer-typed (`guren mcp` exposes them as a request field) and `..` survives both
 * `trimSlashes()` and `kebabCase()`. Reach for it through `writeScaffoldFile`; it cannot
 * live in `writeFileSafe`, whose `guren codegen --out` caller may legitimately write
 * outside `process.cwd()`. `cwd` must be the same root the write resolves against.
 */
export function assertScaffoldPath(relativePath: string, cwd: string = process.cwd()): void {
  const root = resolve(cwd)
  const fullPath = resolve(root, relativePath)

  if (fullPath !== root && !fullPath.startsWith(root + pathSep)) {
    throw new Error(
      `Refusing to write "${relativePath}" — it resolves outside the project root (${fullPath}).`,
    )
  }
}

/**
 * Resolves the root a writer works against, **once**. Callers pin it before checking a
 * path and reuse the result for the write: reading `options.cwd` twice can land on a
 * different directory than the one checked, and the containment check then guarantees
 * nothing. Exported so a generator probing the app before writing judges that same root.
 */
export function writeRoot(options: WriterOptions): string {
  return resolveAppRoot(options)
}

/** `writeFileSafe` for generated scaffolds: containment-checked. */
export async function writeScaffoldFile(
  relativePath: string,
  contents: string,
  options: WriterOptions = {},
): Promise<string> {
  const cwd = writeRoot(options)
  assertScaffoldPath(relativePath, cwd)
  return writeFileSafe(relativePath, contents, { ...options, cwd })
}

export async function writeFileSafe(relativePath: string, contents: string, options: WriterOptions = {}): Promise<string> {
  const fullPath = resolve(options.cwd ?? process.cwd(), relativePath)

  await mkdir(dirname(fullPath), { recursive: true })
  try {
    // `wx` makes the exists-check and the write one atomic operation; a separate
    // access() probe leaves a window where a concurrent writer's file gets clobbered.
    await writeFile(fullPath, contents, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${relativePath} already exists. Use --force to overwrite.`)
    }
    throw error
  }
  return fullPath
}

/**
 * Writes a generated artifact, skipping the write when the file already holds
 * byte-identical content. Codegen re-runs on every save under the watched directories,
 * and rewriting unchanged output bumps mtimes that wake anything watching backend
 * sources. Differing content still goes through `writeFileSafe`, so the
 * "already exists" guard is untouched.
 */
export async function writeGeneratedFile(
  relativePath: string,
  contents: string,
  options: WriterOptions = {},
): Promise<string> {
  const fullPath = resolve(options.cwd ?? process.cwd(), relativePath)

  try {
    if ((await readFile(fullPath, 'utf8')) === contents) {
      return fullPath
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  return writeFileSafe(relativePath, contents, options)
}

/**
 * `writeGeneratedFile` for an artifact whose absolute path was already built from
 * `appRoot`, keeping the "already exists" message project-relative.
 */
export async function writeGeneratedFileIn(
  appRoot: string,
  outputFile: string,
  contents: string,
  options: WriterOptions = {},
): Promise<string> {
  const root = resolve(appRoot)
  return writeGeneratedFile(relative(root, outputFile) || outputFile, contents, {
    ...options,
    cwd: root,
  })
}

/**
 * The project root a command works in: an explicit `appRoot`, else the `cwd`
 * every `WriterOptions` carries, else the process directory.
 */
export function resolveAppRoot(options: { appRoot?: string } & WriterOptions): string {
  return resolve(options.appRoot ?? options.cwd ?? process.cwd())
}

/**
 * Copies the whole of `WriterOptions` across when a command builds a fresh options bag.
 * Rebuilding it field by field is how `cwd` gets silently dropped and the generator
 * writes to the process directory instead of the requested one.
 */
export function writerOptionsFrom(options: WriterOptions): WriterOptions {
  return { force: Boolean(options.force), root: options.root, cwd: options.cwd }
}

/**
 * Refuses an explicit `cwd` on a command that cannot honour it yet. `cwd` rides on the
 * shared `WriterOptions`, so a command inherits the field long before it threads it
 * through every path — writing some files relative to `cwd` and others to the process
 * directory splits one scaffold across two projects. Omitting it is unaffected.
 */
export function assertCwdUnsupported(options: WriterOptions, command: string): void {
  if (options.cwd === undefined) return
  throw new Error(
    `${command} does not support an explicit cwd yet — it still resolves part of its work against `
    + `the process directory, so honouring cwd here would scaffold into two projects at once. `
    + `Run it with the process working directory set to the target project instead.`,
  )
}

/** One file of a multi-file scaffold: app-relative path plus its contents. */
export interface ScaffoldFileEntry {
  path: string
  contents: string
}

/** `writeScaffoldFile` over a batch — every path is checked before any write. */
export async function writeScaffoldFiles(
  entries: ScaffoldFileEntry[],
  options: WriterOptions = {},
): Promise<string[]> {
  const cwd = writeRoot(options)

  for (const entry of entries) {
    assertScaffoldPath(entry.path, cwd)
  }

  const created: string[] = []

  for (const entry of entries) {
    created.push(await writeFileSafe(entry.path, entry.contents, { ...options, cwd }))
  }

  return created
}

export async function scaffoldFile(name: string, config: ScaffoldConfig, options: WriterOptions = {}): Promise<string> {
  const { className, fileName } = resourceName(name)
  const normalizedName = config.suffix ? ensureSuffix(className, config.suffix) : className
  const baseName = config.fileName ? config.fileName({ rawName: name, className, fileName, normalizedName }) : normalizedName
  const extension = config.extension ?? 'ts'
  const dir = options.root ? `modules/${safeModuleName(options.root)}/${config.dir}` : config.dir
  const filePath = extension ? `${dir}/${baseName}.${extension}` : `${dir}/${baseName}`
  const contents = config.template({ rawName: name, className, fileName, normalizedName })
  return writeScaffoldFile(filePath, contents, options)
}

export function pascalCase(value: string): string {
  return value
    .split(/[-_\s]/u)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
    .replace(/[^a-zA-Z0-9]/gu, '')
}

/**
 * Strip leading and trailing slashes without regex backtracking (`/\/+$/` is quadratic on
 * adversarial input). A twin lives in `@guren/server` (`src/support/trim-slashes.ts`);
 * the packages share no dependency edge, so the six lines are duplicated by convention.
 */
/** Split, trim, and drop empties: `'a, b,'` names two entries. */
export function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export function trimSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '/') start++
  while (end > start && value[end - 1] === '/') end--
  return value.slice(start, end)
}

/**
 * Escape a value for interpolation inside generated single-quoted strings. Shared by
 * every codegen emitter so escaping fixes land once.
 */
export function escapeSingleQuoted(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/'/gu, "\\'")
    .replace(/\n/gu, '\\n')
    .replace(/\r/gu, '\\r')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

/**
 * Whether `value` can be written as a bare identifier in generated code. Character shape
 * only: `default` is a fine object key and a syntax error as a type alias name, so a
 * caller emitting a *binding* must rule out reserved words itself.
 */
export function isIdentifier(value: string): boolean {
  return IDENTIFIER_RE.test(value)
}

/**
 * A property key for a generated object or type literal: bare when it is a valid
 * identifier, single-quoted otherwise. Shared by the codegen emitters, like
 * {@link escapeSingleQuoted}, so an emittable key has one spelling.
 */
export function quoteObjectKey(key: string): string {
  return isIdentifier(key) ? key : `'${escapeSingleQuoted(key)}'`
}

/**
 * One Hono route-path param token, as Hono's own parser lexes it: a param starts only at
 * a segment boundary (`/status/foo:bar` is a literal), an attached constraint is consumed
 * whole including one level of nested braces (`{[0-9]{2}}` stays intact), and a trailing
 * `?`/`*` modifier belongs to the token. Group 1 is the boundary, group 2 the label.
 * Shared by every route generator so the lexing rule lands once.
 */
// The constraint is spelled out to one level of nesting rather than with a nested
// quantifier: every class excludes both braces, so a scan stops at the next brace. The
// `\{[^}]*\}(?:[^/]*\})*` shape it replaces was quadratic (CodeQL js/polynomial-redos,
// measured at 2.9s for a 16k-char path vs 1.9ms here).
export const PATH_PARAM_PATTERN = /(^|\/):([A-Za-z0-9_-]+\*?)(?:\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\})?\??/gu

/** Param labels in path order, with constraints and modifiers dropped. */
export function extractPathParamNames(path: string): string[] {
  return Array.from(path.matchAll(PATH_PARAM_PATTERN), (match) => match[2]!)
}

/**
 * Escape a value for interpolation inside generated template literals. Backslashes must
 * go first, or the backtick pass's own `\` gets double-escaped.
 */
export function escapeTemplateLiteral(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/`/gu, '\\`').replace(/\$/gu, '\\$')
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/**
 * Slug for prose input (ADR titles, migration names): lowercase, non-alphanumeric runs
 * collapse to `separator`, edges trimmed — unlike `kebabCase()`, punctuation is dropped.
 * Input with no ASCII alphanumerics falls back to `fallback`, so the sequence number
 * stays the distinguishing part.
 */
export function slugifyProse(value: string, separator: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, separator)
    .replace(new RegExp(`^[${separator}]+|[${separator}]+$`, 'gu'), '')

  return slug || fallback
}

export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[_\s]+/gu, '-')
    .toLowerCase()
}

/**
 * The ESM specifier `fromFile` would use to import `toPath`. Separators are normalized to
 * `/` so generated import lines stay valid on Windows, where `path.relative()` yields `\`.
 */
export function relativeImportPath(fromFile: string, toPath: string): string {
  const rel = relative(dirname(fromFile), toPath) || toPath
  const normalized = rel.split(pathSep).join('/')
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}

/** Escapes `value` for literal use inside a `RegExp` source string. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether `body` — source text with its `import` declarations already removed — uses
 * `name` as an identifier. A word-boundary match over source rather than an AST walk,
 * because "use" is broader than "call": a registrar handed to `defineModule({ routes })`
 * and a command pushed through `forEach(...)` both count. The looseness cuts one way — a
 * name in a comment reads as used, never the reverse — and these checks warn, not fail.
 */
export function referencesIdentifier(body: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'u').test(body)
}

const SAFE_MODULE_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u

/**
 * kebab-cases a `--module <name>` value and rejects anything that would escape the
 * `modules/<name>/` directory it becomes a path segment of: `kebabCase()` alone does not
 * strip `/`, `\`, or `..`. Requiring alphanumeric segments joined by single hyphens
 * rejects those in one check. The first segment must also start with a letter, because
 * codegen PascalCases the name into identifiers and `modules/2fa/` yields `2faInvoice`.
 */
export function safeModuleName(value: string): string {
  const name = kebabCase(value)
  if (!SAFE_MODULE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid module name "${value}" — it becomes a directory segment under modules/ and is PascalCased into `
      + `generated type names, so it must be one or more alphanumeric segments joined by hyphens, starting with `
      + `a letter (e.g. "billing", "billing-ops", "two-factor" rather than "2fa").`,
    )
  }
  return name
}

/** A backslash is a separator on Windows; NUL truncates the path syscall-side. */
const PATH_SEGMENT_SEPARATOR_RE = /[\\\u0000]/u

/**
 * Splits a nested generator name (`make:view posts/Index`) into path segments, rejecting
 * any that is a directory traversal: `trimSlashes()` only touches the edges, so `..`
 * survives `split('/').filter(Boolean)` and walks out of the output directory. Rejected
 * rather than stripped, since rewriting the path would put the file somewhere the caller
 * did not ask for. Only traversal — a narrower charset would break `"admin/my page"`.
 */
export function safePathSegments(value: string, label: string): string[] {
  const segments = trimSlashes(value).split('/').filter(Boolean)

  if (segments.length === 0) {
    throw new Error(`A ${label} is required.`)
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..' || PATH_SEGMENT_SEPARATOR_RE.test(segment)) {
      throw new Error(
        `Invalid ${label} "${value}" — "${segment}" is a path traversal, not a name. `
        + `Use plain nested names such as "posts/Index".`,
      )
    }
  }

  return segments
}

export function resourceName(value: string): { className: string; fileName: string } {
  const className = pascalCase(value)
  const fileName = kebabCase(value)
  return { className, fileName }
}

export function ensureSuffix(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name : `${name}${suffix}`
}

/**
 * A `pages.foo.bar` accessor for a scaffolded controller, matching the nesting and
 * quoting rules pages-types.ts's codegen uses, so generated code references the path
 * codegen will actually produce.
 */
export function pagesAccessor(...keys: Array<string | undefined>): string {
  return keys
    .filter((key): key is string => Boolean(key))
    .reduce((acc, key) => acc + (IDENTIFIER_RE.test(key) ? `.${key}` : `['${key.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}']`), 'pages')
}
