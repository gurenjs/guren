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
 * exist. A declaration the parser cannot fully read is skipped with a
 * warning rather than emitted partially (see `ModelInfo.attachmentsUnreadable`).
 */
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { MODELS_DIR } from './discovery'
import { discoverParsedModels, type DiscoveredModel, type ModelAttachmentCollection } from './model-parser'
import { escapeSingleQuoted, quoteObjectKey, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

export interface GenerateAttachmentTypesOptions extends WriterOptions {
  appRoot?: string
}

const DEFAULT_OUTPUT_FILE = '.guren/attachments.gen.ts'

interface AttachmentEntry {
  className: string
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
  const models = await discoverParsedModels(appRoot)
  const entries = collectAttachmentEntries(models, warnings)

  // No Attachable models: the app does not use attachments. Remove a
  // previously generated file so a stale map stops applying (the
  // translations generator sets the precedent).
  if (entries.length === 0) {
    await rm(outputFile, { force: true })
    return { outputPath: null, models: [], warnings }
  }

  const content = buildAttachmentTypesContent(entries)
  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, content, { force: options.force })

  return { outputPath, models: entries.map((entry) => entry.className), warnings }
}

/**
 * The emittable entries: models with a readable, non-empty declaration,
 * minus class names declared attachable in more than one location. The map
 * keys on class names — the same key the runtime stores as `recordType` —
 * so a duplicated name has no single truthful entry.
 */
function collectAttachmentEntries(models: DiscoveredModel[], warnings: string[]): AttachmentEntry[] {
  const byName = new Map<string, DiscoveredModel[]>()

  for (const model of models) {
    if (model.info.attachmentsUnreadable) {
      warnings.push(
        `${model.relPath}: the Attachable(...) declaration on ${model.info.className} could not be statically read — `
          + `the model is omitted from ${DEFAULT_OUTPUT_FILE}. Declare collections inline with `
          + `hasOneAttached()/hasManyAttached() object literals to include it.`,
      )
      continue
    }
    if (model.info.attachments.length === 0) continue
    const group = byName.get(model.info.className) ?? []
    group.push(model)
    byName.set(model.info.className, group)
  }

  const entries: AttachmentEntry[] = []
  for (const [className, group] of byName) {
    if (group.length > 1) {
      const locations = group.map((model) => model.relPath).sort().join(', ')
      warnings.push(
        `Model class ${className} declares attachments in multiple locations (${locations}) — omitted from `
          + `${DEFAULT_OUTPUT_FILE} because the map keys on class names.`,
      )
      continue
    }
    entries.push({ className, collections: group[0]!.info.attachments })
  }

  return entries.sort((a, b) => a.className.localeCompare(b.className))
}

export function buildAttachmentTypesContent(entries: AttachmentEntry[]): string {
  const kindEntries = entries
    .map((entry) => {
      const collections = entry.collections
        .map((collection) => `${quoteObjectKey(collection.name)}: '${collection.kind}'`)
        .join('; ')
      return `  ${quoteObjectKey(entry.className)}: { ${collections} }`
    })
    .join('\n')

  const variantEntries = entries
    .map((entry) => {
      const collections = entry.collections
        .map((collection) => {
          const union =
            collection.variants.length > 0
              ? [...collection.variants]
                  .sort((a, b) => a.localeCompare(b))
                  .map((variant) => `'${escapeSingleQuoted(variant)}'`)
                  .join(' | ')
              : 'never'
          return `${quoteObjectKey(collection.name)}: ${union}`
        })
        .join('; ')
      return `  ${quoteObjectKey(entry.className)}: { ${collections} }`
    })
    .join('\n')

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
