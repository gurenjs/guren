import { describe, expect, it, spyOn } from 'bun:test'
import { parseImportMap } from '../../src/support/import-map'

describe('parseImportMap', () => {
  it('parses valid JSON maps and ignores empty entries', () => {
    const result = parseImportMap('{"react":"https://cdn/react.js","empty":"","nil":null}')
    expect(result).toEqual({ react: 'https://cdn/react.js' })
  })

  it('warns and returns empty map on invalid JSON', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseImportMap('{bad json', { context: 'test import map' })

    expect(result).toEqual({})
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
