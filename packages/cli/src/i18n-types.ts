/**
 * Generates typed translation keys from the app's `lang/` directory, in the
 * layout `createApp({ i18n })` loads via JsonLoader: one namespace per file.
 * Apps without a `lang/` directory get no file, and keys degrade to `string`.
 *
 * The union covers every key present in *any* locale — the CLI cannot know
 * which locale the app configured as fallback; `guren check --i18n` is the
 * companion that reports keys missing from individual locales.
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { appDependsOn } from './discovery'
import { escapeSingleQuoted, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export interface GenerateTranslationTypesOptions extends WriterOptions {
  appRoot?: string
}

/**
 * The directory codegen, `check --i18n` and the Vite watch all assume. Apps
 * relocating catalogs via `createApp({ i18n: { path } })` opt out of them.
 */
export const DEFAULT_LANG_DIR = 'lang'

const DEFAULT_OUTPUT_FILE = '.guren/translations.gen.ts'

export interface TranslationCatalog {
  locale: string
  /** Dot-notation key (namespace-prefixed, e.g. `nav.posts`) → message. */
  entries: Map<string, string>
  /** Files that failed to parse, relative to the app root. */
  invalidFiles: string[]
  /**
   * Keys the runtime can never resolve, because a JSON property or catalog
   * file name contains a literal dot and the Translator always reads a dot as
   * a path separator. Excluded from `entries`, reported by `check --i18n`.
   */
  unreachableKeys: string[]
}

/** Every `<langDir>/<locale>/*.json` catalog; empty when there is no such dir. */
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
    const catalog: TranslationCatalog = {
      locale,
      entries: new Map(),
      invalidFiles: [],
      unreachableKeys: [],
    }

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
        catalog.invalidFiles.push(relative(appRoot, filePath))
        continue
      }

      collectEntries(parsed, namespace, catalog, namespace.includes('.'))
    }

    catalogs.push(catalog)
  }

  return catalogs.sort((a, b) => a.locale.localeCompare(b.locale))
}

function collectEntries(
  value: unknown,
  prefix: string,
  catalog: TranslationCatalog,
  unreachable: boolean,
): void {
  if (typeof value === 'string') {
    if (unreachable) {
      catalog.unreachableKeys.push(prefix)
    } else {
      catalog.entries.set(prefix, value)
    }
    return
  }
  // Arrays index like objects at runtime (`items.0`), so Object.entries
  // covers both.
  if (value !== null && typeof value === 'object') {
    for (const [child, childValue] of Object.entries(value)) {
      collectEntries(childValue, `${prefix}.${child}`, catalog, unreachable || child.includes('.'))
    }
  }
}

export async function generateTranslationTypes(
  options: GenerateTranslationTypesOptions = {},
): Promise<{ outputPath: string | null; keyCount: number }> {
  const appRoot = resolveAppRoot(options)
  const catalogs = await readTranslationCatalogs(appRoot)
  const outputFile = resolve(appRoot, DEFAULT_OUTPUT_FILE)

  // Removed rather than left in place, so a stale augmentation stops applying
  // and keys return to plain strings.
  if (catalogs.length === 0) {
    await rm(outputFile, { force: true })
    return { outputPath: null, keyCount: 0 }
  }

  const keys = Array.from(new Set(catalogs.flatMap((catalog) => [...catalog.entries.keys()]))).sort()

  const content = buildTranslationTypesContent(keys, {
    locales: catalogs.map((catalog) => catalog.locale),
    // TypeScript rejects augmenting an uninstalled module (TS2664), which
    // would break API-only apps.
    augmentInertiaClient: await appUsesInertiaClient(appRoot),
  })

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, content, {
    force: options.force,
  })

  return { outputPath, keyCount: keys.length }
}

/** `=== true` because an unreadable manifest should skip optional output, not break the build. */
async function appUsesInertiaClient(appRoot: string): Promise<boolean> {
  return (await appDependsOn(appRoot, '@guren/inertia-client')) === true
}

/** Keep interpolated names from breaking out of the generated header comment. */
function sanitizeForComment(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]/gu, ' ')
}

export function buildTranslationTypesContent(
  keys: string[],
  context: { locales: string[]; augmentInertiaClient: boolean },
): string {
  const union =
    keys.length > 0
      ? keys.map((key) => `  | '${escapeSingleQuoted(key)}'`).join('\n')
      : '  | never'

  const clientAugmentation = context.augmentInertiaClient
    ? `

declare module '@guren/inertia-client' {
  interface GurenTranslationKeys {
    keys: TranslationKey
  }
}`
    : ''

  return `// Generated from ${DEFAULT_LANG_DIR}/ (locales: ${sanitizeForComment(context.locales.join(', '))}) — DO NOT EDIT
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
}${clientAugmentation}
`
}
