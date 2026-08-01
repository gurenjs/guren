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
  SINGLE_CHILD_WRAPPERS,
  TRANSPARENT_WRAPPERS,
  typeOf,
} from './zod-compat'

/** Reach into a schema's `_def`, which is exactly what these helpers exist to read. */
const defOf = (schema: unknown): Record<string, unknown> =>
  (schema as { _def: Record<string, unknown> })._def

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
  test('reads a zod 4 enum (entries object)', () => {
    expect(enumValues(defOf(z.enum(['a', 'b'])))).toEqual(['a', 'b'])
  })

  test('z.nativeEnum produces the same enum node', () => {
    enum Color { Red = 'red', Blue = 'blue' }
    const def = defOf(z.nativeEnum(Color))
    expect(typeOf(z.nativeEnum(Color) as never)).toBe('enum')
    expect(enumValues(def)).toEqual(['red', 'blue'])
  })

  test('filters the reverse mappings of a numeric TypeScript enum', () => {
    enum Level { Low, High }
    // The runtime object is { Low: 0, High: 1, '0': 'Low', '1': 'High' } —
    // only the forward direction may reach a rendered document.
    expect(enumValues(defOf(z.nativeEnum(Level)))).toEqual([0, 1])
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
  // The two walkers partition these differently — the CLI splits transparent
  // from presence-deciding because it walks types and presence separately,
  // while the OpenAPI walker looks through all of them uniformly. What they
  // must never do is disagree about membership, so the partitions are pinned
  // here rather than restated in each package.
  test('SINGLE_CHILD_WRAPPERS is the union of both partitions plus the specially-rendered two', () => {
    expect([...SINGLE_CHILD_WRAPPERS].sort()).toEqual([
      'catch', 'default', 'lazy', 'nonoptional',
      'nullable', 'optional', 'pipe', 'prefault', 'readonly',
    ])
  })

  test('the partitions are disjoint and both contained in the whole', () => {
    for (const name of TRANSPARENT_WRAPPERS) {
      expect(PRESENCE_WRAPPERS.has(name)).toBe(false)
      expect(SINGLE_CHILD_WRAPPERS.has(name)).toBe(true)
    }
    for (const name of PRESENCE_WRAPPERS) {
      expect(SINGLE_CHILD_WRAPPERS.has(name)).toBe(true)
    }
  })

  test('every wrapper in the vocabulary really is a single-child node in zod 4', () => {
    // Built per name so a stale entry fails loudly rather than by omission.
    const build: Record<string, () => unknown> = {
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
    for (const name of SINGLE_CHILD_WRAPPERS) {
      const schema = build[name]
      expect(schema, `no builder for wrapper "${name}"`).toBeDefined()
      expect(typeOf(schema!() as never)).toBe(name)
    }
  })
})
