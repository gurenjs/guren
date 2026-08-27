/**
 * Generates the cross-boundary attachment map from `Attachable(...)` model
 * declarations (RFC 0013, RFC 0010 §2).
 *
 * Scans `app/Models/` — at the project root and inside every
 * `modules/<name>/` — for models whose heritage clause wraps
 * `Attachable(Base, { ... })`, reads each collection's kind and variant
 * names from the declaration, and emits `.guren/attachments.gen.ts`. The
 * model itself is typed by the mixin's generics; the map exists for the
 * surfaces that cannot see `typeof Post.attachments` — pages, resources,
 * upload clients, and `guren check`.
 *
 * Apps without Attachable models get no file — a previously generated one
 * is removed so a stale map stops describing collections that no longer
 * exist. Removal is on positive evidence only: when a model was skipped
 * with a warning (an unparsable file, an unreadable declaration), an
 * existing file is left in place rather than deleted on uncertainty — the
 * same rule `attachments:prune` follows.
 *
 * This runs on every codegen (Vite dev startup included), so files are
 * pre-filtered on the mixin's name before parsing; a file that never says
 * `Attachable` can neither declare the mixin nor warrant a warning.
 */
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MODELS_DIR, discoverModelFiles, toPosixRelative } from './discovery'
import { parseModelSource, type ModelAttachmentCollection } from './model-parser'
import { escapeSingleQuoted, quoteObjectKey, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export interface GenerateAttachmentTypesOptions extends WriterOptions {
  appRoot?: string
}

const DEFAULT_OUTPUT_FILE = '.guren/attachments.gen.ts'

interface AttachmentEntry {
  className: string
  relPath: string
  collections: ModelAttachmentCollection[]
}

export async function generateAttachmentTypes(
  options: GenerateAttachmentTypesOptions = {},
): Promise<{ outputPath: string | null; models: string[]; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, DEFAULT_OUTPUT_FILE)

  // Returned rather than logged, same contract as `generateDataTypes`:
  // `guren codegen` prints them, and the MCP codegen tool hands them to the
  // agent that asked for the run.
  const warnings: string[] = []
  const entries = await collectAttachmentEntries(appRoot, warnings)

  if (entries.length === 0) {
    // No Attachable models: the app does not use attachments, so remove a
    // previously generated file (the translations generator's precedent) —
    // but only when nothing was skipped. A warning means an Attachable
    // model may exist that this run could not read, and an outdated map
    // plus the warning beats deleting the module out from under its
    // importers.
    if (warnings.length === 0) {
      await rm(outputFile, { force: true })
    }
    return { outputPath: null, models: [], warnings }
  }

  const content = buildAttachmentTypesContent(entries)
  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, content, { force: options.force })

  return { outputPath, models: entries.map((entry) => entry.className), warnings }
}

/**
 * The emittable entries: models with a readable `Attachable(...)`
 * declaration (an empty one counts — `Attachable(Base, {})` is still an
 * Attachable model), minus class names declared attachable in more than one
 * location. The map keys on class names — the same key the runtime stores
 * as `recordType` — so a duplicated name has no single truthful entry.
 */
async function collectAttachmentEntries(appRoot: string, warnings: string[]): Promise<AttachmentEntry[]> {
  const files = await discoverModelFiles(appRoot)
  const sources = await Promise.all(
    files.map(async (file) => {
      try {
        return await readFile(file, 'utf-8')
      } catch {
        return null
      }
    }),
  )

  const byName = new Map<string, AttachmentEntry[]>()
  files.forEach((file, index) => {
    const source = sources[index]
    if (!source || !source.includes('Attachable')) return
    const relPath = toPosixRelative(appRoot, file)

    const info = parseModelSource(source, file)
    if (!info) {
      warnings.push(
        `${relPath}: the file could not be read as a model (parse failure or no class declaration) — `
          + `any Attachable(...) model it declares is missing from ${DEFAULT_OUTPUT_FILE}.`,
      )
      return
    }
    if (info.attachments === 'unreadable') {
      warnings.push(
        `${relPath}: the Attachable(...) declaration on ${info.className} could not be statically read — `
          + `the model is omitted from ${DEFAULT_OUTPUT_FILE}. Declare collections inline with `
          + `hasOneAttached()/hasManyAttached() object literals to include it.`,
      )
      return
    }
    if (info.attachments === null) return

    const entry: AttachmentEntry = { className: info.className, relPath, collections: info.attachments }
    const group = byName.get(entry.className) ?? []
    group.push(entry)
    byName.set(entry.className, group)
  })

  const entries: AttachmentEntry[] = []
  for (const [className, group] of byName) {
    if (group.length > 1) {
      const locations = group.map((entry) => entry.relPath).sort().join(', ')
      warnings.push(
        `Model class ${className} declares attachments in multiple locations (${locations}) — omitted from `
          + `${DEFAULT_OUTPUT_FILE} because the map keys on class names.`,
      )
      continue
    }
    entries.push(group[0]!)
  }

  return entries.sort((a, b) => a.className.localeCompare(b.className))
}

/**
 * One entry line per model, `{ collection: <value> }` per collection. Both
 * emitted interfaces render through here so they are structurally guaranteed
 * to key identically — consumers index `AttachmentVariantsMap[M]` with names
 * from `AttachmentsMap[M]`.
 */
function renderMap(entries: AttachmentEntry[], valueFor: (collection: ModelAttachmentCollection) => string): string {
  return entries
    .map((entry) => {
      const collections = entry.collections
        .map((collection) => `${quoteObjectKey(collection.name)}: ${valueFor(collection)}`)
        .join('; ')
      return `  ${quoteObjectKey(entry.className)}: ${collections.length > 0 ? `{ ${collections} }` : '{}'}`
    })
    .join('\n')
}

export function buildAttachmentTypesContent(entries: AttachmentEntry[]): string {
  const kindEntries = renderMap(entries, (collection) => `'${collection.kind}'`)
  const variantEntries = renderMap(entries, (collection) =>
    collection.variants.length > 0
      ? [...collection.variants]
          .sort((a, b) => a.localeCompare(b))
          .map((variant) => `'${escapeSingleQuoted(variant)}'`)
          .join(' | ')
      : 'never',
  )

  return `// Generated from ${MODELS_DIR} (and modules/*/${MODELS_DIR}) — DO NOT EDIT
// Run \`guren codegen\` to regenerate.

/**
 * Each Attachable model's attachment collections, keyed the way the runtime
 * keys attachment rows: by the model's class name. Values map collection
 * name → kind ('one' = hasOneAttached, 'many' = hasManyAttached).
 */
export interface AttachmentsMap {
${kindEntries}
}

/**
 * Variant names each collection declares; \`never\` for collections that
 * declare none.
 */
export interface AttachmentVariantsMap {
${variantEntries}
}

export type AttachableModelName = keyof AttachmentsMap
export type AttachmentName<M extends keyof AttachmentsMap> = keyof AttachmentsMap[M]
`
}
