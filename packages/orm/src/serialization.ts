import type { AccessorDefinitions } from './attributes'
import { applyAccessors } from './attributes'
import type { PlainObject } from './Model'

/**
 * Serialize a model record for API/JSON output.
 *
 * Applies hidden/visible filtering, casts, accessors, and appends.
 */
export function serializeRecord(
  record: PlainObject,
  options: {
    hidden?: string[]
    visible?: string[]
    appends?: string[]
    accessors?: AccessorDefinitions
  },
): PlainObject {
  let result = { ...record }

  // Apply accessors for appended virtual attributes
  if (options.appends && options.accessors) {
    for (const key of options.appends) {
      if (options.accessors[key]) {
        result[key] = options.accessors[key](result)
      }
    }
  }

  // Apply visible whitelist
  if (options.visible && options.visible.length > 0) {
    const filtered: PlainObject = {}
    for (const key of options.visible) {
      if (key in result) filtered[key] = result[key]
    }
    result = filtered
  } else if (options.hidden && options.hidden.length > 0) {
    // Apply hidden blacklist
    for (const key of options.hidden) {
      delete result[key]
    }
  }

  return result
}

/** Serialize an array of records. */
export function serializeRecords(
  records: PlainObject[],
  options: Parameters<typeof serializeRecord>[1],
): PlainObject[] {
  return records.map((r) => serializeRecord(r, options))
}
