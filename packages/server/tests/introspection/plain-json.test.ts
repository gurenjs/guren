import { describe, expect, test } from 'bun:test'
import { toPlainJson } from '../../src/introspection/plain-json'

class Controller {}

describe('toPlainJson()', () => {
  test('drops undefined keys and turns undefined array items into null, as JSON.stringify does', () => {
    const value = { a: 1, b: undefined, c: [{ d: undefined }, undefined] }

    expect(toPlainJson<unknown>(value)).toStrictEqual({ a: 1, c: [{}, null] })
    expect(toPlainJson<unknown>(value)).toStrictEqual(JSON.parse(JSON.stringify(value)))
  })

  test('refuses what JSON cannot carry, naming where', () => {
    expect(() => toPlainJson({ routes: new Map() })).toThrow('manifest.routes (Map) cannot be carried by JSON')
    expect(() => toPlainJson({ hook: () => {} })).toThrow('manifest.hook (function) cannot be carried by JSON')
    expect(() => toPlainJson({ controller: new Controller() })).toThrow('manifest.controller (Controller) cannot be carried by JSON')
    expect(() => toPlainJson({ size: Infinity })).toThrow('manifest.size (Infinity)')
  })

  test('refuses a cycle with its path, and copies a shared object seen twice', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const shared = { x: 1 }

    expect(() => toPlainJson({ route: cyclic })).toThrow('manifest.route.self (a reference to its own ancestor)')
    expect(toPlainJson({ a: shared, b: shared })).toStrictEqual({ a: { x: 1 }, b: { x: 1 } })
  })
})
