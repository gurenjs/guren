import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { comparePlanDictionaries, loadPlanDictionaries, PLAN_LOCALES, type PlanDictionary } from '../src/plan/locales'

interface FakeNode {
  nodeType: number
  tag?: string
  href?: string
  children: FakeNode[]
  text?: string
  readonly textContent: string
  appendChild(child: FakeNode): FakeNode
  cloneNode(deep: boolean): FakeNode
}

function fakeNode(nodeType: number, init: { tag?: string; text?: string; href?: string } = {}): FakeNode {
  return {
    nodeType,
    ...init,
    children: [],
    get textContent(): string {
      return this.nodeType === 3 ? (this.text ?? '') : this.children.map((child) => child.textContent).join('')
    },
    appendChild(child) {
      this.children.push(child)
      return child
    },
    cloneNode() {
      const copy = fakeNode(this.nodeType, { tag: this.tag, text: this.text, href: this.href })
      for (const child of this.children) copy.appendChild(child.cloneNode(true))
      return copy
    },
  }
}

const fakeDocument = { createTextNode: (text: string) => fakeNode(3, { text }) }

function fakeLink(id: string): FakeNode {
  const anchor = fakeNode(1, { tag: 'a', href: `#el-${id}` })
  anchor.appendChild(fakeNode(3, { text: id }))
  return anchor
}

type Values = Record<string, unknown>
interface Formatter {
  formatInto(host: FakeNode, template: string, values?: Values): FakeNode
  formatText(template: string, values?: Values): string
}

const formatter = new Function(
  'document',
  `${readFileSync(join(import.meta.dir, '../assets/plan/format.js'), 'utf8')}\nreturn { formatInto: formatInto, formatText: formatText }`,
)(fakeDocument) as Formatter

const dictionaries = loadPlanDictionaries()

describe('the plan dictionaries', () => {
  test.each(PLAN_LOCALES.filter((locale) => locale !== 'en'))('should give %s the keys and placeholders en has', (locale) => {
    expect(comparePlanDictionaries(dictionaries.en, dictionaries[locale])).toEqual([])
  })

  const broken = (edit: (copy: PlanDictionary) => void): PlanDictionary => {
    const copy = { ...dictionaries.ja }
    edit(copy)
    return copy
  }

  test('should report a key the translation lacks', () => {
    const problems = comparePlanDictionaries(
      dictionaries.en,
      broken((copy) => delete copy['acceptance.calls']),
    )

    expect(problems).toEqual([expect.objectContaining({ key: 'acceptance.calls', kind: 'missing' })])
  })

  test('should report a key only the translation has', () => {
    const problems = comparePlanDictionaries(
      dictionaries.en,
      broken((copy) => {
        copy['acceptance.extra'] = '余分'
      }),
    )

    expect(problems).toEqual([expect.objectContaining({ key: 'acceptance.extra', kind: 'extra' })])
  })

  test.each([
    ['renamed', '{who} が {route} を呼ぶ'],
    ['dropped', '{actor} が呼ぶ'],
    ['added', '{actor} が {route} を {extra} で呼ぶ'],
  ])('should report a %s placeholder', (_name, value) => {
    const problems = comparePlanDictionaries(
      dictionaries.en,
      broken((copy) => {
        copy['acceptance.calls'] = value
      }),
    )

    expect(problems).toEqual([expect.objectContaining({ key: 'acceptance.calls', kind: 'placeholders' })])
  })

  test('should report a :name placeholder, which the page would print as text', () => {
    const problems = comparePlanDictionaries(
      dictionaries.en,
      broken((copy) => {
        copy['acceptance.status'] = 'ステータス:status {status}'
      }),
    )

    expect(problems.map((problem) => problem.kind)).toContain('colon-placeholder')
  })
})

describe('the plan page formatter', () => {
  test('should follow the order of the template, not of the values', () => {
    const values = (): Values => ({ actor: 'guest', route: fakeLink('route.posts.store') })

    const en = formatter.formatInto(fakeNode(1), dictionaries.en['acceptance.calls']!, values())
    const ja = formatter.formatInto(fakeNode(1), dictionaries.ja['acceptance.calls']!, values())

    expect(en.textContent).toBe('a guest calls route.posts.store')
    expect(ja.textContent).toBe('guest が route.posts.store を呼ぶ')
  })

  test('should append a node placeholder as that node, inside the sentence', () => {
    const route = fakeLink('route.posts.store')

    const host = formatter.formatInto(fakeNode(1), dictionaries.ja['acceptance.calls']!, { actor: 'guest', route })

    expect(host.children.map((child) => child.nodeType)).toEqual([3, 3, 1, 3])
    expect(host.children[2]).toBe(route)
    expect(host.children[2]!.href).toBe('#el-route.posts.store')
  })

  test('should leave an unknown placeholder on the page as written', () => {
    expect(formatter.formatInto(fakeNode(1), 'a {actor} calls {route}', { actor: 'guest' }).textContent).toBe(
      'a guest calls {route}',
    )
    expect(formatter.formatText('{shown} of {total}', { shown: 1, total: null })).toBe('1 of {total}')
  })

  test('should not read a placeholder off the prototype chain', () => {
    expect(formatter.formatText('{constructor} {toString}', {})).toBe('{constructor} {toString}')
  })

  test('should write a value spelling a placeholder as text, never expand it', () => {
    const host = formatter.formatInto(fakeNode(1), 'a {actor} calls {route}', { actor: '{route}', route: 'r' })

    expect(host.textContent).toBe('a {route} calls r')
  })

  test('should keep both sites when a template names one node twice', () => {
    const route = fakeLink('route.posts.store')

    const host = formatter.formatInto(fakeNode(1), '{route} then {route}', { route })

    expect(host.textContent).toBe('route.posts.store then route.posts.store')
    expect(host.children[0]).toBe(route)
    expect(host.children[2]).not.toBe(route)
    expect(host.children[2]!.href).toBe('#el-route.posts.store')
  })

  test('should write braces in a value as text', () => {
    expect(formatter.formatText('{table} has {values}', { table: 'posts', values: 'meta = {"a":{}}' })).toBe(
      'posts has meta = {"a":{}}',
    )
  })

  test('should write falsy values rather than drop them', () => {
    expect(formatter.formatText('{shown} of {total}', { shown: 0, total: '' })).toBe('0 of ')
  })

  test('should give a string site the text of a node value', () => {
    expect(formatter.formatText('Review {id}', { id: fakeLink('model.post') })).toBe('Review model.post')
  })
})
