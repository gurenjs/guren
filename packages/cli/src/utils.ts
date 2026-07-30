import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
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

export async function writeFileSafe(relativePath: string, contents: string, options: WriterOptions = {}): Promise<string> {
  const fullPath = resolve(process.cwd(), relativePath)

  if (!options.force) {
    try {
      await access(fullPath)
      throw new Error(`${relativePath} already exists. Use --force to overwrite.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, contents, 'utf8')
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

export async function writeFilesSafe(
  entries: Array<{ path: string; contents: string }>,
  options: WriterOptions = {},
): Promise<string[]> {
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
  return writeFileSafe(filePath, contents, options)
}

export function pascalCase(value: string): string {
  return value
    .replace(/(?:^|[-_\s]+)([a-zA-Z])/gu, (_, char: string) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/gu, '')
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
