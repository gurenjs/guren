import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep as pathSep } from 'node:path'

export interface WriterOptions {
  force?: boolean
  /**
   * When set (via `--module <name>`), prefixes a generator's output
   * directory with `modules/<kebab-case root>/` instead of writing to the
   * project root — e.g. `app/Http/Controllers` becomes
   * `modules/billing/app/Http/Controllers`. Normalized to kebab-case the
   * same way `make:module` derives its directory name, so `--module Billing`
   * and `make:module Billing` target the same `modules/billing/` directory.
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

/**
 * Spawn a command with inherited stdio and resolve when it exits cleanly.
 */
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
 * Throws unless `relativePath` stays under the project root.
 *
 * Scaffolders build their output path out of a name they were handed, and
 * those names are not all developer-typed: `guren mcp` exposes them as a
 * request field. `..` survives both `trimSlashes()` and `kebabCase()`, so
 * without this a name like `../../../../tmp/evil` writes outside the project.
 *
 * Reach for it through `writeScaffoldFile`/`writeScaffoldFiles` rather than
 * calling it directly — a generator that picks the right writer gets
 * containment for free, and one that picks `writeFileSafe` is visibly opting
 * out. Codegen is the reason the check cannot simply live in `writeFileSafe`:
 * `guren codegen --out` takes a caller-supplied directory that may
 * legitimately sit outside `process.cwd()`.
 */
export function assertScaffoldPath(relativePath: string): void {
  const root = process.cwd()
  const fullPath = resolve(root, relativePath)

  if (fullPath !== root && !fullPath.startsWith(root + pathSep)) {
    throw new Error(
      `Refusing to write "${relativePath}" — it resolves outside the project root (${fullPath}).`,
    )
  }
}

/** `writeFileSafe` for generated scaffolds: containment-checked. */
export async function writeScaffoldFile(
  relativePath: string,
  contents: string,
  options: WriterOptions = {},
): Promise<string> {
  assertScaffoldPath(relativePath)
  return writeFileSafe(relativePath, contents, options)
}

export async function writeFileSafe(relativePath: string, contents: string, options: WriterOptions = {}): Promise<string> {
  const fullPath = resolve(process.cwd(), relativePath)

  await mkdir(dirname(fullPath), { recursive: true })
  try {
    // `wx` makes the exists-check and the write one atomic operation; a
    // separate access() probe leaves a window where a concurrent writer's
    // file gets clobbered.
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
 * Writes a generated artifact, skipping the write entirely when the file
 * already holds byte-identical content.
 *
 * Codegen re-runs on every save under `resources/js/pages/`,
 * `app/Http/Resources/`, and `routes/web.ts` (see `vite/route-types.ts`), and
 * controllers import the results (`@/.guren/pages.gen`). Rewriting unchanged
 * output bumps those files' mtimes, which wakes up anything watching backend
 * sources for no reason. Comparing first keeps a no-op run a real no-op.
 *
 * Differing content still goes through `writeFileSafe`, so the
 * "already exists. Use --force to overwrite." guard is untouched — identical
 * content is simply not a clobber worth guarding against.
 */
export async function writeGeneratedFile(
  relativePath: string,
  contents: string,
  options: WriterOptions = {},
): Promise<string> {
  const fullPath = resolve(process.cwd(), relativePath)

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

/** `writeScaffoldFile` over a batch — every path is checked before any write. */
export async function writeScaffoldFiles(
  entries: Array<{ path: string; contents: string }>,
  options: WriterOptions = {},
): Promise<string[]> {
  for (const entry of entries) {
    assertScaffoldPath(entry.path)
  }

  const created: string[] = []

  for (const entry of entries) {
    created.push(await writeFileSafe(entry.path, entry.contents, options))
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
 * Strip leading and trailing slashes without regex backtracking
 * (`/\/+$/` is quadratic on adversarial input). A twin lives in
 * `@guren/server` (`src/support/trim-slashes.ts`); the packages share no
 * dependency edge, so the six lines are duplicated by convention.
 */
export function trimSlashes(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '/') start++
  while (end > start && value[end - 1] === '/') end--
  return value.slice(start, end)
}

/**
 * Escape a value for interpolation inside generated single-quoted strings.
 * Shared by the codegen emitters (routes, channels, API client) so escaping
 * fixes land once.
 */
export function escapeSingleQuoted(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")
}

/**
 * Escape a value for interpolation inside generated template literals.
 * Backslashes must go first — escaping them after the backtick pass would
 * double-escape the `\` it just inserted.
 */
export function escapeTemplateLiteral(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/`/gu, '\\`').replace(/\$/gu, '\\$')
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/**
 * Slug for prose input (ADR titles, migration names): lowercase,
 * non-alphanumeric runs collapse to `separator`, edges trimmed. Unlike
 * `kebabCase()`, punctuation is dropped rather than preserved. Input with
 * no ASCII alphanumerics at all (e.g. a fully Japanese title) falls back
 * to `fallback` so the sequence number stays the distinguishing part.
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
 * Builds the ESM specifier that `fromFile` would use to import `toPath`.
 * Separators are normalized to `/` so generated and printed import lines stay
 * valid on Windows, where `path.relative()` yields `\`.
 */
export function relativeImportPath(fromFile: string, toPath: string): string {
  const rel = relative(dirname(fromFile), toPath) || toPath
  const normalized = rel.split(pathSep).join('/')
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}

/**
 * Escapes `value` for literal use inside a `RegExp` source string.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SAFE_MODULE_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/u

/**
 * kebab-cases a `--module <name>`/`make:module <name>` value and rejects
 * anything that would escape the `modules/<name>/` directory it becomes a
 * path segment of. `kebabCase()` alone doesn't strip `/`, `\`, or `..` — a
 * name like `../../outside` or `/etc/passwd` would resolve outside the
 * project root wherever it's interpolated into a scaffold path. Requiring
 * the result to be one or more alphanumeric segments joined by single
 * hyphens rejects those, plus anything else that isn't a plain directory
 * name (empty, all-symbol, leading/trailing hyphen, etc.) in one check.
 */
export function safeModuleName(value: string): string {
  const name = kebabCase(value)
  if (!SAFE_MODULE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid module name "${value}" — it becomes a directory segment under modules/, so it must be one or `
      + `more alphanumeric segments joined by hyphens (e.g. "billing", "billing-ops").`,
    )
  }
  return name
}

/** A backslash is a separator on Windows; NUL truncates the path syscall-side. */
const PATH_SEGMENT_SEPARATOR_RE = /[\\\u0000]/u

/**
 * Splits a nested generator name (`make:view posts/Index`,
 * `make:test auth/Login`) into path segments, rejecting any segment that is a
 * directory traversal rather than a name.
 *
 * `trimSlashes()` only touches the edges, so `..` survives
 * `split('/').filter(Boolean)` — it is non-empty — and walks out of the
 * generator's output directory once interpolated into the path. Segments are
 * rejected rather than stripped because nesting is the documented feature
 * here: silently rewriting the path would put the file somewhere the caller
 * did not ask for.
 *
 * Only traversal is rejected, not unusual characters. `pascalCase()` already
 * accepts space-separated words, so narrowing to an identifier charset here
 * would break `make:test "admin/my page"` — which the filesystem, and every
 * release before this check, accepted.
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

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u

/**
 * Builds a `pages.foo.bar` accessor for a scaffolded controller, matching the
 * nesting/quoting rules pages-types.ts's codegen uses to build the `pages`
 * object (one key per resources/js/pages/ directory segment, bracket-quoted
 * when a segment isn't a valid identifier) so generated code references the
 * same path codegen will actually produce.
 */
export function pagesAccessor(...keys: Array<string | undefined>): string {
  return keys
    .filter((key): key is string => Boolean(key))
    .reduce((acc, key) => acc + (IDENTIFIER_RE.test(key) ? `.${key}` : `['${key.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}']`), 'pages')
}
