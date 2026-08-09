/**
 * Generates typed translation keys from the app's `lang/` directory.
 *
 * Scans `lang/<locale>/*.json` (the layout `createApp({ i18n })` loads via
 * JsonLoader: one namespace per file), flattens nested objects into
 * dot-notation keys prefixed with the file's namespace, and emits
 * `.guren/translations.gen.ts` exporting a `TranslationKey` union plus
 * declaration-merging augmentations that type `this.t()` / `this.tc()` on
 * the server and `useTranslation()` on the client. Apps without a `lang/`
 * directory get no file — the registries stay empty and keys degrade to
 * `string`.
 *
 * The union covers every key present in *any* locale (the CLI cannot know
 * which locale the app configured as fallback); `guren check --i18n` is the
 * companion that reports keys missing from individual locales.
 */
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export interface GenerateTranslationTypesOptions extends WriterOptions {
  appRoot?: string
  /** Translation directory (defaults to `lang`). */
  langDir?: string
  outputFile?: string
}

const DEFAULT_LANG_DIR = 'lang'
const DEFAULT_OUTPUT_FILE = '.guren/translations.gen.ts'

export interface TranslationCatalog {
  locale: string
  /** Dot-notation key (namespace-prefixed, e.g. `nav.posts`) → message. */
  entries: Map<string, string>
  /** Files that failed to parse, relative to the app root. */
  invalidFiles: string[]
}

/**
 * Read every `<langDir>/<locale>/*.json` catalog. Returns an empty array
 * when the directory does not exist.
 */
export async function readTranslationCatalogs(
  appRoot: string,
  langDir: string = DEFAULT_LANG_DIR,
): Promise<TranslationCatalog[]> {
  const base = resolve(appRoot, langDir)

  let localeEntries
  try {
    localeEntries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }

  const catalogs: TranslationCatalog[] = []

  for (const entry of localeEntries) {
    if (!entry.isDirectory()) continue
    const locale = entry.name
    const localePath = resolve(base, locale)
    const entries = new Map<string, string>()
    const invalidFiles: string[] = []

    let files: string[]
    try {
      files = await readdir(localePath)
    } catch {
      continue
    }

    for (const file of files.sort()) {
      if (extname(file) !== '.json') continue
      const namespace = file.slice(0, -'.json'.length)
      const filePath = resolve(localePath, file)

      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(filePath, 'utf-8'))
      } catch {
        invalidFiles.push(relative(appRoot, filePath))
        continue
      }

      collectEntries(parsed, namespace, entries)
    }

    catalogs.push({ locale, entries, invalidFiles })
  }

  return catalogs.sort((a, b) => a.locale.localeCompare(b.locale))
}

function collectEntries(value: unknown, prefix: string, entries: Map<string, string>): void {
  if (typeof value === 'string') {
    entries.set(prefix, value)
    return
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [child, childValue] of Object.entries(value)) {
      collectEntries(childValue, `${prefix}.${child}`, entries)
    }
  }
}

export async function generateTranslationTypes(
  options: GenerateTranslationTypesOptions = {},
): Promise<{ outputPath: string | null; keyCount: number }> {
  const appRoot = resolveAppRoot(options)
  const langDir = options.langDir ?? DEFAULT_LANG_DIR
  const catalogs = await readTranslationCatalogs(appRoot, langDir)

  // No lang/ directory (or no locale subdirectories): the app does not use
  // file-based translations — emit nothing so keys stay `string`.
  if (catalogs.length === 0) {
    return { outputPath: null, keyCount: 0 }
  }

  const keys = Array.from(new Set(catalogs.flatMap((catalog) => [...catalog.entries.keys()]))).sort()

  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)
  const content = buildTranslationTypesContent(keys, {
    source: relative(appRoot, resolve(appRoot, langDir)) || langDir,
    locales: catalogs.map((catalog) => catalog.locale),
  })

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, content, {
    force: options.force,
  })

  return { outputPath, keyCount: keys.length }
}

export function buildTranslationTypesContent(
  keys: string[],
  context: { source: string; locales: string[] },
): string {
  const union =
    keys.length > 0
      ? keys.map((key) => `  | '${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join('\n')
      : '  | never'

  return `// Generated from ${context.source}/ (locales: ${context.locales.join(', ')}) — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

/**
 * Every translation key present in at least one locale. Missing-per-locale
 * keys are reported by \`guren check --i18n\`, not here.
 */
export type TranslationKey =
${union}

// Type this app's translation helpers via declaration merging:
// \`this.t()\` / \`this.tc()\` in controllers and \`useTranslation()\` in pages
// autocomplete and reject unknown keys. Delete lang/ and regenerate to
// return them to plain strings.
declare module '@guren/core' {
  interface GurenTranslationKeys {
    keys: TranslationKey
  }
}

declare module '@guren/inertia-client' {
  interface GurenTranslationKeys {
    keys: TranslationKey
  }
}
`
}
