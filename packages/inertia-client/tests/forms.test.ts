import { describe, expect, it } from 'bun:test'
import {
  deriveFieldInput,
  describeField,
  fromDateTimeLocal,
  humanizeFieldName,
  normalizeBlankFields,
  numberAttributes,
  requiresValue,
  resolveFieldLabel,
  resolveOptionLabel,
  resolveRouteUrl,
  selectErrorBag,
  toDateTimeLocal,
  useRouteForm,
  type DescribeFieldInput,
  type FieldContract,
  type FieldState,
  type RouteFormContract,
} from '../src/forms'
import type { I18nPageProps } from '../src/i18n'

const text = (overrides: Partial<FieldContract> = {}): FieldContract => ({ type: 'string', required: true, ...overrides })

function field(contract: FieldContract | undefined, value: unknown, extra: Partial<DescribeFieldInput<unknown>> = {}) {
  const writes: unknown[] = []
  const state = describeField<unknown>({ id: 'f', name: 'startsAt', value, contract, setValue: (next) => writes.push(next), ...extra })
  return { state, writes }
}

function control(state: FieldState<unknown>): Record<string, unknown> {
  return state.control as unknown as Record<string, unknown>
}

describe('humanizeFieldName', () => {
  it('turns camel, snake and kebab case into a sentence', () => {
    expect(humanizeFieldName('startsAt')).toBe('Starts at')
    expect(humanizeFieldName('starts_at')).toBe('Starts at')
    expect(humanizeFieldName('contact-email')).toBe('Contact email')
    expect(humanizeFieldName('title')).toBe('Title')
  })

  it('keeps an acronym as one word', () => {
    expect(humanizeFieldName('homepageURL')).toBe('Homepage url')
    expect(humanizeFieldName('HTMLBody')).toBe('Html body')
  })
})

describe('deriveFieldInput', () => {
  it('reads the input kind off the contract', () => {
    expect(deriveFieldInput({ type: 'boolean', required: true })).toBe('checkbox')
    expect(deriveFieldInput(text({ enum: ['news', 'howto'] }))).toBe('select')
    expect(deriveFieldInput({ type: 'integer', required: true })).toBe('number')
    expect(deriveFieldInput(text({ format: 'email' }))).toBe('email')
    expect(deriveFieldInput(text({ format: 'uri' }))).toBe('url')
    expect(deriveFieldInput(text({ format: 'date' }))).toBe('date')
    expect(deriveFieldInput(text({ format: 'date-time' }))).toBe('datetime')
    expect(deriveFieldInput({ type: 'unknown', required: false })).toBe('text')
    expect(deriveFieldInput(undefined)).toBe('text')
  })
})

describe('requiresValue', () => {
  it('leaves a string that accepts the empty string optional in the browser', () => {
    expect(requiresValue(text(), 'text', '')).toBe(false)
    expect(requiresValue(text({ minLength: 1 }), 'text', '')).toBe(true)
  })

  it('never requires a nullable field or a checkbox', () => {
    expect(requiresValue(text({ minLength: 1, nullable: true }), 'text', 'x')).toBe(false)
    expect(requiresValue({ type: 'boolean', required: true }, 'checkbox', false)).toBe(false)
  })

  it('requires an optional, non-nullable field that starts with a value', () => {
    const optionalNumber: FieldContract = { type: 'number', required: false }
    expect(requiresValue(optionalNumber, 'number', '')).toBe(false)
    expect(requiresValue(optionalNumber, 'number', 3)).toBe(true)
  })
})

describe('normalizeBlankFields', () => {
  const fields = {
    title: text({ minLength: 1 }),
    note: text({ required: false, nullable: true }),
    subtitle: text({ required: false }),
    tagline: text({ required: false }),
  }

  it('sends null for a nullable key, nothing for one that was always blank, and the empty string otherwise', () => {
    const data = { title: '', note: '', subtitle: '', tagline: '' }
    const initial = { title: 'Hello', note: 'x', subtitle: '', tagline: 'Old' }
    expect(normalizeBlankFields(fields, data, initial)).toEqual({ title: '', note: null, tagline: '' })
  })

  it('leaves filled values and keys outside the contract alone', () => {
    const data = { title: 'Hi', note: 'n', subtitle: 's', tagline: 't', extra: '' }
    expect(normalizeBlankFields(fields, data, data)).toEqual(data)
  })
})

describe('numberAttributes', () => {
  it('raises min to the first multiple of the step, which the browser counts from', () => {
    expect(numberAttributes({ type: 'number', required: true, minimum: 1, multipleOf: 2 })).toEqual({ min: 2, step: 2 })
    expect(numberAttributes({ type: 'integer', required: true, minimum: 0.5 })).toEqual({ min: 1, step: 1 })
    expect(numberAttributes({ type: 'number', required: true, minimum: 0.1, multipleOf: 0.1 })).toEqual({ min: 0.1, step: 0.1 })
  })

  it('leaves min alone when any value is allowed', () => {
    expect(numberAttributes({ type: 'number', required: true, minimum: 1.5, maximum: 9 })).toEqual({ min: 1.5, max: 9, step: 'any' })
  })
})

describe('selectErrorBag', () => {
  it('adopts the flat errors, or the named bag', () => {
    expect(selectErrorBag({ email: 'Invalid' })).toEqual({ email: 'Invalid' })
    expect(selectErrorBag({ profile: { email: 'Invalid' } }, 'profile')).toEqual({ email: 'Invalid' })
  })

  it('adopts nothing when the bag is absent or empty', () => {
    expect(selectErrorBag({ email: 'Invalid' }, 'profile')).toBeUndefined()
    expect(selectErrorBag({})).toBeUndefined()
    expect(selectErrorBag(undefined)).toBeUndefined()
  })
})

describe('resolveRouteUrl', () => {
  it('substitutes and encodes parameters', () => {
    expect(resolveRouteUrl('/posts/:id', { id: 'a b' })).toBe('/posts/a%20b')
  })

  it('drops an optional segment left without a value', () => {
    expect(resolveRouteUrl('/posts/:page?')).toBe('/posts')
  })

  it('throws on a required parameter left without a value', () => {
    expect(() => resolveRouteUrl('/posts/:id')).toThrow(':id')
  })
})

describe('date-time controls', () => {
  it('shows an ISO timestamp in local time and reads it back as the same instant', () => {
    const iso = '2026-11-01T03:22:00.000Z'
    const local = toDateTimeLocal(iso)
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(fromDateTimeLocal(local, 'string')).toBe(iso)
  })

  it('keeps seconds visible and steps by one when the stored value has them', () => {
    const { state } = field(text({ format: 'date-time' }), '2026-11-01T03:22:55.000Z')
    expect(String(control(state).value)).toMatch(/:\d{2}:\d{2}$/)
    expect(control(state).step).toBe(1)
  })

  it('submits a Date when the schema takes one', () => {
    expect(fromDateTimeLocal('2026-11-01T12:00', 'Date')).toBeInstanceOf(Date)
    expect(fromDateTimeLocal('', 'Date')).toBe('')
  })

  it('writes nothing until the control changes, so an untouched value goes back as received', () => {
    const { writes } = field(text({ format: 'date-time' }), '2026-11-01T03:22:55.123Z')
    expect(writes).toEqual([])
  })
})

describe('describeField', () => {
  it('wires the label, the error and the aria attributes', () => {
    const { state } = field(text({ minLength: 1, maxLength: 120 }), '', { error: 'Required.', overrides: { hint: 'Shown on cards.' } })
    expect(state.label).toBe('Starts at')
    expect(state.error).toBe('Required.')
    expect(control(state)).toMatchObject({
      id: 'f',
      required: true,
      minLength: 1,
      maxLength: 120,
      'aria-invalid': true,
      'aria-describedby': 'f-hint f-error',
    })
  })

  it('leaves aria attributes off while there is no error or hint', () => {
    const { state } = field(text(), 'x')
    expect(control(state)['aria-invalid']).toBeUndefined()
    expect(control(state)['aria-describedby']).toBeUndefined()
  })

  it('steps a number by any unless the schema says otherwise', () => {
    expect(control(field({ type: 'number', required: true }, 1).state).step).toBe('any')
    expect(control(field({ type: 'integer', required: true }, 1).state).step).toBe(1)
    expect(control(field({ type: 'number', required: true, multipleOf: 0.5 }, 1).state).step).toBe(0.5)
  })

  it('maps a select option back to its original member', () => {
    const { state, writes } = field({ type: 'number', required: true, enum: [10, 20] }, 20)
    expect(state.input).toBe('select')
    expect(control(state).value).toBe('1')
    ;(control(state).onChange as (event: { target: { value: string } }) => void)({ target: { value: '0' } })
    expect(writes).toEqual([10])
  })

  it('lets `as` and `label` win over the contract', () => {
    const { state } = field(text(), 'x', { overrides: { as: 'textarea', label: 'Body' } })
    expect(state.input).toBe('textarea')
    expect(state.label).toBe('Body')
  })

  it('derives nothing without a contract', () => {
    const { state } = field(undefined, '')
    expect(state.input).toBe('text')
    expect(state.required).toBe(false)
  })
})

describe('translated labels', () => {
  const i18n = (locale: string, messages: I18nPageProps['messages']): I18nPageProps => ({ locale, fallbackLocale: 'en', messages })
  const catalogs: I18nPageProps['messages'] = {
    en: {
      fields: {
        title: { label: 'Headline' },
        category: { label: 'Section', options: { news: 'News desk' } },
        posts: { store: { title: { label: 'Post headline' } } },
      },
    },
    ja: {
      fields: {
        title: { label: '見出し' },
        category: { options: { news: 'ニュース' } },
        posts: { update: { title: { label: '見出しの変更' } } },
        empty: { label: '' },
      },
    },
  }

  it('lets the label prop win over a translation', () => {
    const { state } = field(text(), 'x', { name: 'title', i18n: i18n('en', catalogs), route: 'posts.store', overrides: { label: 'Title' } })
    expect(state.label).toBe('Title')
  })

  it('reads the route-scoped key before the field key', () => {
    expect(resolveFieldLabel('title', i18n('en', catalogs), 'posts.store')).toBe('Post headline')
    expect(resolveFieldLabel('title', i18n('ja', catalogs), 'posts.update')).toBe('見出しの変更')
  })

  it('reads the field key when the route has none, or the form has no route', () => {
    expect(resolveFieldLabel('title', i18n('ja', catalogs))).toBe('見出し')
  })

  it('prefers any key in the current locale over the fallback locale', () => {
    // ja has only the field key, en the route-scoped one: the page stays in Japanese.
    expect(resolveFieldLabel('title', i18n('ja', catalogs), 'posts.store')).toBe('見出し')
  })

  it('falls back to the fallback locale, the route-scoped key first', () => {
    expect(resolveFieldLabel('category', i18n('ja', catalogs), 'posts.store')).toBe('Section')
    expect(resolveFieldLabel('title', i18n('fr', catalogs), 'posts.store')).toBe('Post headline')
  })

  it('humanizes the name without _i18n, on a miss, or on an empty translation', () => {
    expect(resolveFieldLabel('startsAt')).toBe('Starts at')
    expect(resolveFieldLabel('startsAt', i18n('ja', catalogs), 'posts.store')).toBe('Starts at')
    expect(resolveFieldLabel('empty', i18n('ja', catalogs))).toBe('Empty')
  })

  it('never looks up a name with a dot, which the translator would split', () => {
    const dotted = i18n('en', { en: { fields: { meta: { title: { label: 'Wrong' } } } } })
    expect(resolveFieldLabel('meta.title', dotted)).toBe('Meta title')
  })

  it('passes the shared props through describeField', () => {
    const { state } = field(text(), 'x', { name: 'title', i18n: i18n('en', catalogs), route: 'posts.store' })
    expect(state.label).toBe('Post headline')
  })

  it('translates enum options by value, in the current locale or its fallback', () => {
    const shared = i18n('ja', catalogs)
    expect(resolveOptionLabel('category', 'news', shared)).toBe('ニュース')
    expect(resolveOptionLabel('category', 'howTo', shared)).toBe('How to')
    const { state } = field({ type: 'string', required: true, enum: ['news', 'howTo'] }, 'news', { name: 'category', i18n: shared })
    if (state.input !== 'select') throw new Error('expected a select')
    expect(state.options.map((option) => option.label)).toEqual(['ニュース', 'How to'])
  })

  it('humanizes an option value that is not a key segment', () => {
    const shared = i18n('en', { en: { fields: { rate: { options: { 1: 'One', 5: 'Half' } } } } })
    expect(resolveOptionLabel('rate', 1, shared)).toBe('One')
    expect(resolveOptionLabel('rate', 1.5, shared)).toBe('1 5')
  })

  it('lets caller options win over translations', () => {
    const { state } = field({ type: 'string', required: true, enum: ['news'] }, 'news', {
      name: 'category',
      i18n: i18n('ja', catalogs),
      overrides: { options: [{ value: 'news', label: 'Press' }] },
    })
    if (state.input !== 'select') throw new Error('expected a select')
    expect(state.options[0]!.label).toBe('Press')
  })
})

// Compiled by the root typecheck, never run: the bodies are the shapes RFC 0036 §2.2 names.
export function typeOnly(): void {
  type Post = { title: string; summary?: string; meta: Record<string, any>; cover: File | null }
  const store: RouteFormContract<'posts.store', 'POST', '/posts', Post> = {
    route: 'posts.store',
    method: 'POST',
    path: '/posts',
    fields: { title: { type: 'string', required: true } },
  }
  const update: RouteFormContract<'posts.update', 'PUT', '/posts/:id', Post> = { ...store, route: 'posts.update', method: 'PUT', path: '/posts/:id' }
  const initial: Post = { title: '', meta: {}, cover: null }

  useRouteForm(store, initial)
  useRouteForm(update, initial, { params: { id: 1 } })
  // @ts-expect-error a path with parameters needs `params`
  useRouteForm(update, initial)
  // @ts-expect-error a path without parameters takes none
  useRouteForm(store, initial, { params: { id: 1 } })
  // @ts-expect-error the initial data must match the contract's body
  useRouteForm(store, { title: 1, meta: {}, cover: null })
}
