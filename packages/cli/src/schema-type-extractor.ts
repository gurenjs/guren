/**
 * Extracts TypeScript type literals from Zod schema objects at runtime.
 * Supports both Zod v3 (`_def.typeName`) and Zod v4 (`_def.type` / `.type`).
 */

interface ZodAnyLike {
  _def?: Record<string, unknown>
  type?: string
  shape?: Record<string, ZodAnyLike>
}

function getTypeName(z: ZodAnyLike): string | undefined {
  // v3: _def.typeName = "ZodString" etc.
  // v4: _def.type = "string" etc. or top-level .type
  return (z._def?.typeName as string) ?? (z._def?.type as string) ?? z.type
}

/**
 * Convert a Zod schema object to a TypeScript type string.
 * Returns `undefined` if the schema structure is unrecognizable.
 */
export function schemaToTypeString(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const z = schema as ZodAnyLike
  if (!getTypeName(z)) return undefined
  return zodToType(z)
}

function zodToType(z: ZodAnyLike): string {
  const tn = getTypeName(z)!
  const def = z._def ?? {}

  // Normalize: v3 uses "ZodString", v4 uses "string"
  const t = tn.startsWith('Zod') ? tn.slice(3).toLowerCase() : tn.toLowerCase()

  switch (t) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'bigint': return 'bigint'
    case 'date': return 'Date'
    case 'undefined': return 'undefined'
    case 'null': return 'null'
    case 'void': return 'void'
    case 'any': return 'any'
    case 'unknown': return 'unknown'
    case 'never': return 'never'

    case 'literal': {
      // v3: _def.value, v4: _def.values[]
      if ('value' in def) return JSON.stringify(def.value)
      const vals = def.values as unknown[]
      if (vals) return vals.map((v) => JSON.stringify(v)).join(' | ')
      return 'unknown'
    }

    case 'array': {
      const el = (def.type ?? def.element) as ZodAnyLike | undefined
      if (el) return `${wrapComplex(zodToType(el))}[]`
      return 'unknown[]'
    }

    case 'object': {
      // v3: _def.shape() is a function, v4: _def.shape is an object
      const shape = typeof def.shape === 'function'
        ? (def.shape as () => Record<string, ZodAnyLike>)()
        : (def.shape ?? z.shape) as Record<string, ZodAnyLike> | undefined
      if (!shape) return 'Record<string, unknown>'
      const entries = Object.entries(shape)
      if (entries.length === 0) return '{}'
      const fields = entries.map(([key, val]) => {
        const opt = isOptional(val) ? '?' : ''
        return `${key}${opt}: ${zodToType(val)}`
      })
      return `{ ${fields.join('; ')} }`
    }

    case 'optional':
      return inner(def) ? zodToType(inner(def)!) : 'unknown'

    case 'nullable': {
      const i = inner(def)
      return i ? `${zodToType(i)} | null` : 'unknown | null'
    }

    case 'default':
    case 'catch':
    case 'readonly':
    case 'branded':
    case 'lazy':
      return inner(def) ? zodToType(inner(def)!) : 'unknown'

    case 'effects':
      // v3: .transform()/.refine() wraps in ZodEffects
      return inner(def) ? zodToType(inner(def)!) : 'unknown'

    case 'pipe':
      // v4: .transform() creates a pipe with _def.in
      return (def.in as ZodAnyLike) ? zodToType(def.in as ZodAnyLike) : 'unknown'

    case 'transform':
      return 'unknown'

    case 'union':
    case 'discriminatedunion': {
      const opts = def.options as ZodAnyLike[] | undefined
      if (opts) return opts.map((o) => zodToType(o)).join(' | ')
      return 'unknown'
    }

    case 'intersection': {
      const l = def.left as ZodAnyLike | undefined
      const r = def.right as ZodAnyLike | undefined
      return `${l ? zodToType(l) : 'unknown'} & ${r ? zodToType(r) : 'unknown'}`
    }

    case 'record': {
      const vt = (def.valueType ?? def.type) as ZodAnyLike | undefined
      return vt ? `Record<string, ${zodToType(vt)}>` : 'Record<string, unknown>'
    }

    case 'enum': {
      // v3: _def.values[], v4: _def.entries {}
      const vals = def.values as string[] | undefined
      if (vals) return vals.map((v) => JSON.stringify(v)).join(' | ')
      const entries = def.entries as Record<string, string> | undefined
      if (entries) return Object.values(entries).map((v) => JSON.stringify(v)).join(' | ')
      return 'string'
    }

    case 'nativeenum':
      return 'string | number'

    case 'tuple':
      return 'unknown[]'

    case 'promise': {
      const i = inner(def) ?? (def.type as ZodAnyLike | undefined)
      return i ? `Promise<${zodToType(i)}>` : 'Promise<unknown>'
    }

    default:
      return 'unknown'
  }
}

function inner(def: Record<string, unknown>): ZodAnyLike | undefined {
  // v3: innerType or schema, v4: innerType
  return (def.innerType ?? def.schema) as ZodAnyLike | undefined
}

function isOptional(z: ZodAnyLike): boolean {
  const tn = getTypeName(z)
  if (!tn) return false
  const t = tn.startsWith('Zod') ? tn.slice(3).toLowerCase() : tn.toLowerCase()
  if (t === 'optional' || t === 'default') return true
  const def = z._def ?? {}
  const i = inner(def)
  if ((t === 'effects' || t === 'nullable' || t === 'pipe') && i) return isOptional(i)
  if (t === 'pipe' && def.in) return isOptional(def.in as ZodAnyLike)
  return false
}

function wrapComplex(type: string): string {
  return type.includes('|') || type.includes('&') ? `(${type})` : type
}
