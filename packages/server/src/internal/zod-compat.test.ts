import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import * as z3 from 'zod/v3'
import {
  arrayElement,
  enumValues,
  isTransform,
  isZod3Schema,
  literalValues,
  objectShape,
  pipeSide,
  pipeSides,
  PRESENCE_WRAPPERS,
  schemaAt,
  schemaChecks,
  schemaFormat,
  SINGLE_CHILD_WRAPPERS,
  TRANSPARENT_WRAPPERS,
  typeOf,
  unwrapSingleChild,
} from './zod-compat'

/** Reach into a schema's `_def`, which is exactly what these helpers exist to read. */
const defOf = (schema: unknown): Record<string, unknown> =>
  (schema as { _def: Record<string, unknown> })._def

/**
 * One node per member of the wrapper vocabulary, shared by every test that has
 * to build them. Pinned to `SINGLE_CHILD_WRAPPERS` by the key-equality check in
 * `wrapper vocabulary` below, so a wrapper added to the set with no builder here
 * fails once rather than silently narrowing whatever iterates this.
 */
const WRAPPER_BUILDERS: Record<string, () => unknown> = {
  catch: () => z.string().catch('x'),
  readonly: () => z.string().readonly(),
  lazy: () => z.lazy(() => z.string()),
  optional: () => z.string().optional(),
  default: () => z.string().default('x'),
  prefault: () => z.string().prefault('x'),
  nonoptional: () => z.string().optional().nonoptional(),
  nullable: () => z.string().nullable(),
  pipe: () => z.string().pipe(z.coerce.number()),
}

describe('isZod3Schema', () => {
  // zod 4 ships the v3 API as the `zod/v3` subpath, so a v3-shaped node can
  // arrive from an app that declares only zod 4. Detection has to run before
  // any other read: on a v3 node `_def.type` holds a nested schema, and every
  // v4-shaped read would misfire on it.
  test('detects a node authored with the zod/v3 subpath', () => {
    expect(isZod3Schema(z3.string() as never)).toBe(true)
    expect(isZod3Schema(z3.object({ a: z3.number() }) as never)).toBe(true)
  })

  test('does not flag zod 4 nodes or bare objects', () => {
    expect(isZod3Schema(z.string() as never)).toBe(false)
    expect(isZod3Schema({} as never)).toBe(false)
  })
})

describe('typeOf', () => {
  test('reads a zod 4 type name', () => {
    expect(typeOf(z.string() as never)).toBe('string')
  })

  test('returns "unknown" for a node with no readable type name', () => {
    expect(typeOf({} as never)).toBe('unknown')
  })

  test('does not mistake a v3 nested schema in _def.type for a name', () => {
    // A v3 array stores its element schema in `_def.type`. The name read must
    // refuse the object rather than return it.
    expect(typeOf(z3.array(z3.string()) as never)).toBe('unknown')
  })
})

describe('arrayElement', () => {
  // v4 puts the string 'array' in `_def.type` alongside the real element in
  // `_def.element`. Reading `_def.type` here is the bug the predecessors of
  // this module fixed twice, once per package.
  test('reads the element, not the type-name string in _def.type', () => {
    const def = defOf(z.array(z.string()))
    expect(def.type).toBe('array')
    const element = arrayElement(def)
    expect(element).toBeDefined()
    expect(typeOf(element!)).toBe('string')
  })
})

describe('objectShape', () => {
  test('reads a zod 4 object shape', () => {
    const shape = objectShape(z.object({ name: z.string() }) as never)
    expect(shape && Object.keys(shape)).toEqual(['name'])
  })
})

describe('pipeSide', () => {
  test('reads the coerced-from side for input, the parsed side for output', () => {
    const def = defOf(z.string().pipe(z.coerce.number()))
    expect(typeOf(pipeSide(def, 'input')!)).toBe('string')
    expect(typeOf(pipeSide(def, 'output')!)).toBe('number')
  })

  test('falls back to the input side when the output side is a transform', () => {
    const def = defOf(z.string().transform((value) => value.length))
    expect(typeOf(pipeSide(def, 'output')!)).toBe('string')
  })

  test('pipeSides omits a transform out side so callers cannot read a function as a schema', () => {
    const transformed = pipeSides(defOf(z.string().transform((value) => value.length)))
    expect(transformed.to).toBeUndefined()
    expect(typeOf(transformed.from!)).toBe('string')

    const piped = pipeSides(defOf(z.string().pipe(z.coerce.number())))
    expect(typeOf(piped.to!)).toBe('number')
  })
})

describe('isTransform', () => {
  test('identifies a transform node', () => {
    const def = defOf(z.string().transform((value) => value.length))
    const out = schemaAt(def, 'out')!
    expect(isTransform(out)).toBe(true)
  })

  test('a plain schema is not a transform', () => {
    expect(isTransform(z.string() as never)).toBe(false)
  })
})

describe('enumValues', () => {
  test('reads a zod 4 enum', () => {
    expect(enumValues(z.enum(['a', 'b']) as never)).toEqual(['a', 'b'])
  })

  test('z.nativeEnum produces the same enum node', () => {
    enum Color { Red = 'red', Blue = 'blue' }
    expect(typeOf(z.nativeEnum(Color) as never)).toBe('enum')
    expect(enumValues(z.nativeEnum(Color) as never)).toEqual(['red', 'blue'])
  })

  test('excludes the reverse mappings of a numeric TypeScript enum', () => {
    enum Level { Low, High }
    // The runtime object is { Low: 0, High: 1, '0': 'Low', '1': 'High' } —
    // only the forward direction may reach a rendered document.
    expect(enumValues(z.nativeEnum(Level) as never)).toEqual([0, 1])
  })

  test('keeps a member whose value collides with another key', () => {
    // The trap that killed the hand-rolled reverse-mapping filter: `A` maps
    // to the *string* 'B' while `B` is a key holding a number, so any
    // "does my value point at a number?" heuristic wrongly discards A. zod's
    // own computed set gets it right, which is why this reads `_zod.values`.
    enum Tricky { A = 'B', B = 1 }
    const schema = z.nativeEnum(Tricky)
    expect(schema.safeParse('B').success).toBe(true)
    expect(schema.safeParse(1).success).toBe(true)
    expect(new Set(enumValues(schema as never))).toEqual(new Set(['B', 1]))
  })
})

describe('literalValues', () => {
  test('reads zod 4 literal values', () => {
    expect(literalValues(defOf(z.literal('a')))).toEqual(['a'])
  })

  test('reads a multi-value zod 4 literal', () => {
    expect(literalValues(defOf(z.literal(['a', 'b'])))).toEqual(['a', 'b'])
  })
})

describe('wrapper vocabulary', () => {
  // The walkers partition these differently — the CLI's type renderer splits
  // transparent from presence-deciding because it walks types and presence
  // separately, while the JSON Schema walker looks through all of them
  // uniformly. What they must never do is disagree about membership, so the
  // partitions are pinned here rather than restated in each package.
  test('SINGLE_CHILD_WRAPPERS is the union of both partitions plus the specially-rendered two', () => {
    expect([...SINGLE_CHILD_WRAPPERS].sort()).toEqual([
      'catch', 'default', 'lazy', 'nonoptional',
      'nullable', 'optional', 'pipe', 'prefault', 'readonly',
    ])
  })

  // Containment in the whole is true by construction (`SINGLE_CHILD_WRAPPERS`
  // is built as the union), so only disjointness has failure power.
  test('the two partitions are disjoint', () => {
    for (const name of TRANSPARENT_WRAPPERS) {
      expect(PRESENCE_WRAPPERS.has(name)).toBe(false)
    }
  })

  test('every wrapper in the vocabulary really is a single-child node in zod 4', () => {
    // Key equality both ways: a wrapper without a builder AND a stale builder
    // for a name outside the set fail here, before the loop runs. Every
    // other test that iterates `WRAPPER_BUILDERS` inherits that guarantee.
    expect(Object.keys(WRAPPER_BUILDERS).sort()).toEqual([...SINGLE_CHILD_WRAPPERS].sort())
    for (const [name, make] of Object.entries(WRAPPER_BUILDERS)) {
      expect(typeOf(make() as never)).toBe(name)
    }
  })
})

describe('unwrapSingleChild', () => {
  // Three walks look through wrappers for different reasons and reach
  // different conclusions from what they find; the step itself is shared so
  // they cannot disagree about *which* child a wrapper has.
  test('reaches the child of every wrapper that exposes one', () => {
    for (const [name, make] of Object.entries(WRAPPER_BUILDERS)) {
      // `lazy` hides its child from every walker and `pipe` has one per
      // direction; both get their own test below.
      if (name === 'lazy' || name === 'pipe') continue
      const node = make() as never
      // Identity against zod's own `_def.innerType`, not merely "defined": a
      // step that returned the wrapper unchanged would satisfy a definedness
      // check while silently failing to descend, which is the whole job.
      expect(unwrapSingleChild(node, 'input'), name).toBe(defOf(node).innerType as never)
    }
  })

  // The one member of the vocabulary with no reachable child: zod keeps it
  // behind `_def.getter`, which no walker calls. Callers must read this as
  // "contents unavailable" rather than "not a wrapper" — the JSON Schema
  // walker warns instead of silently dropping the property.
  test('cannot reach through a lazy schema', () => {
    expect(unwrapSingleChild(z.lazy(() => z.string()) as never, 'input')).toBeUndefined()
  })

  // A pipe is the reason this takes an `io` at all: the two sides are
  // different schemas, and reading the wrong one describes a value nobody
  // sends or receives.
  test('resolves a pipe to the side matching the direction', () => {
    const piped = z.string().pipe(z.coerce.number()) as never
    expect(typeOf(unwrapSingleChild(piped, 'input') as never)).toBe('string')
    expect(typeOf(unwrapSingleChild(piped, 'output') as never)).toBe('number')
  })

  // A transform's out side is the transform function, so there is no schema to
  // read there and both directions fall back to the input side.
  test('falls back to the input side of a transform, which has no readable output', () => {
    const transformed = z.string().transform((value) => value.length) as never
    expect(typeOf(unwrapSingleChild(transformed, 'output') as never)).toBe('string')
  })

  test('returns undefined for a node that is not a wrapper', () => {
    expect(unwrapSingleChild(z.string() as never, 'input')).toBeUndefined()
    expect(unwrapSingleChild(z.object({ a: z.string() }) as never, 'input')).toBeUndefined()
    expect(unwrapSingleChild({} as never, 'input')).toBeUndefined()
  })
})

describe('schemaChecks', () => {
  // `_def.checks` is heterogeneous: a plain refinement is stored as a bare
  // check object, while a format method stores the whole format *schema* in the
  // same array. Both carry the check definition at `_zod.def`, and nothing else
  // about them is shared — a reader taking the entries at face value sees two
  // unrelated shapes.
  test('normalizes both entry shapes to their check definitions', () => {
    expect(schemaChecks(z.string().min(2).max(5) as never)).toEqual([
      expect.objectContaining({ check: 'min_length', minimum: 2 }),
      expect.objectContaining({ check: 'max_length', maximum: 5 }),
    ])

    const [format] = schemaChecks(z.string().url() as never)
    expect(format).toMatchObject({ check: 'string_format', format: 'url' })
  })

  test('returns an empty list for a node with no checks', () => {
    expect(schemaChecks(z.string() as never)).toEqual([])
    expect(schemaChecks(z.object({}) as never)).toEqual([])
  })

  // A caller switches on `check`, so an entry without one can only be misread.
  test('drops entries that carry no check discriminator', () => {
    expect(schemaChecks({ _def: { checks: [{ _zod: { def: { minimum: 1 } } }, 'nonsense', null] } })).toEqual([])
  })
})

describe('schemaFormat', () => {
  // The two spellings of a format record it in different places, and a reader
  // that consults only one silently loses half the formats an app writes.
  test('reads the format the top-level constructors declare on the node', () => {
    expect(schemaFormat(z.email() as never)).toBe('email')
    expect(schemaFormat(z.iso.datetime() as never)).toBe('datetime')
    expect(schemaFormat(z.int() as never)).toBe('safeint')
  })

  test('is undefined for the string methods, which record the format as a check', () => {
    expect(schemaFormat(z.string().email() as never)).toBeUndefined()
    expect(schemaChecks(z.string().email() as never)[0]).toMatchObject({ format: 'email' })
  })

  test('is undefined for a node with no format', () => {
    expect(schemaFormat(z.string() as never)).toBeUndefined()
  })
})
