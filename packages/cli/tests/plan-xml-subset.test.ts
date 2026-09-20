import { describe, expect, test } from 'bun:test'

import { XML_SUBSET_LIMITS, XmlSubsetError, parseXmlSubset, type XmlSubsetLimits } from '../src/plan/xml-subset'

function reason(input: string, limits?: XmlSubsetLimits): string {
  try {
    parseXmlSubset(input, limits)
  } catch (error) {
    if (error instanceof XmlSubsetError) return error.message
    throw error
  }
  throw new Error('expected the document to be refused')
}

function value(input: string, limits?: XmlSubsetLimits): string | undefined {
  return parseXmlSubset(input, limits).attributes.get('v')
}

describe('parseXmlSubset', () => {
  test('should read an element, its attributes and its children', () => {
    const root = parseXmlSubset(`<r a="1" b='2'><c /><c d="3"></c></r>`)

    expect(root.name).toBe('r')
    expect([...root.attributes]).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
    expect(root.children.map((child) => child.name)).toEqual(['c', 'c'])
    expect(root.children[1]?.attributes.get('d')).toBe('3')
  })

  test('should decode the named entities and both numeric notations', () => {
    expect(value(`<r v="&lt;&gt;&amp;&quot;&apos;&#65;&#x42;" />`)).toBe(`<>&"'AB`)
  })

  test('should refuse a raw < inside an attribute value', () => {
    expect(reason(`<r v="a<b" />`)).toContain('a raw < inside the v attribute')
  })
})

/**
 * Every limit is the caller's, and each default is pinned by an input one either side
 * of it: a constant read back from `XML_SUBSET_LIMITS` would agree with any value.
 */
describe('parseXmlSubset limits', () => {
  test('should refuse a reference one character past the default span and read one at it', () => {
    expect(value(`<r v="&#x10FFFF;" />`)).toBe(String.fromCodePoint(0x10ffff))
    expect(value(`<r v="&#1114111;" />`)).toBe(String.fromCodePoint(0x10ffff))
    expect(reason(`<r v="&#x0010FFF;" />`)).toContain('longer than any this reader decodes')
    expect(reason(`<r v="&#01114111;" />`)).toContain('longer than any this reader decodes')
  })

  test('should take the reference span from the caller', () => {
    expect(value(`<r v="&#x0010FFF;" />`, { maxReferenceSpan: 10 })).toBe(String.fromCodePoint(0x10fff))
    expect(reason(`<r v="&#x10FFFF;" />`, { maxReferenceSpan: 8 })).toContain('longer than any this reader decodes')
  })

  test('should refuse nesting one level past the default depth', () => {
    const nested = (depth: number) => `${'<d>'.repeat(depth)}${'</d>'.repeat(depth)}`

    expect(parseXmlSubset(nested(XML_SUBSET_LIMITS.maxDepth)).name).toBe('d')
    expect(reason(nested(XML_SUBSET_LIMITS.maxDepth + 1))).toBe(
      `elements nest deeper than ${XML_SUBSET_LIMITS.maxDepth}`,
    )
  })

  test('should take the depth from the caller', () => {
    expect(reason('<a><b><c /></b></a>', { maxDepth: 1 })).toBe('elements nest deeper than 1')
  })

  test('should take the document and attribute caps from the caller', () => {
    expect(reason('<r />', { maxChars: 2 })).toBe('the document is over 2 characters')
    expect(reason(`<r v="abcd" />`, { maxAttributeChars: 2 })).toContain('the v attribute at offset 3 is over 2')
  })

  test('should take the name length from the caller, which keeps a long name out of the message', () => {
    expect(parseXmlSubset('<abcdef />', { maxNameChars: 6 }).name).toBe('abcdef')
    expect(reason('<abcdef />', { maxNameChars: 3 })).toBe('malformed <abc> tag at offset 0')
  })

  test('should fall back to a default for a limit the caller leaves out', () => {
    expect(reason('<r />', { maxChars: 2, maxDepth: undefined })).toBe('the document is over 2 characters')
    expect(reason(`<r v="&#x0010FFF;" />`, { maxChars: 1024 })).toContain('longer than any this reader decodes')
  })
})
