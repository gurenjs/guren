import { describe, expect, it } from 'bun:test'
import { describeField, type FieldContract } from '../src/forms'
import { adoptTypedValue, recordTypedValues, takeTypedValue, typedValueOf, type TypedValue } from '../src/typed-before-hydration'

// A fresh control's value as a browser sanitizes it; only the `datetime-local` rule matters here.
const doc = {
  createElement: () => {
    let raw = ''
    return {
      type: 'text',
      get value() {
        return this.type === 'datetime-local' ? raw.replace(/:00$/, '') : raw
      },
      set value(next: string) {
        raw = next
      },
    }
  },
}

type Control = Parameters<typeof typedValueOf>[0]

const input = (fields: Partial<Control>): Control => ({ tagName: 'INPUT', type: 'text', value: '', defaultValue: '', ownerDocument: doc, ...fields })
const option = (value: string, defaultSelected = false, disabled = false) => ({ value, defaultSelected, disabled })

function field(contract: FieldContract, value: unknown, as?: 'hidden') {
  const writes: unknown[] = []
  const state = describeField<unknown>({ id: 'f', name: 'title', value, contract, setValue: (next) => writes.push(next), ...(as ? { overrides: { as } } : {}) })
  return { state, writes }
}

const typed = (fields: Partial<TypedValue>): TypedValue => ({
  kind: 'input', type: 'text', value: '', valueAsNumber: Number.NaN, checked: false, files: null, markup: '', optionValues: [], ...fields,
})

describe('typedValueOf', () => {
  it('reads a control whose value left its markup', () => {
    expect(typedValueOf(input({ value: 'typed' }))).toMatchObject({ kind: 'input', type: 'text', value: 'typed' })
    expect(typedValueOf(input({ type: 'number', value: '7', valueAsNumber: 7 }))).toMatchObject({ valueAsNumber: 7 })
    expect(typedValueOf({ tagName: 'TEXTAREA', value: 'edited', defaultValue: 'stored', ownerDocument: doc })).toMatchObject({ kind: 'textarea', value: 'edited' })
    expect(typedValueOf(input({ type: 'checkbox', checked: true, defaultChecked: false }))).toMatchObject({ kind: 'checkbox', checked: true })
    expect(typedValueOf(input({ type: 'file', files: [{ name: 'cover.png' }] }))).toMatchObject({ kind: 'file' })
  })

  it('leaves alone a control that still shows its markup, sanitized as the browser does', () => {
    expect(typedValueOf(input({ value: 'stored', defaultValue: 'stored' }))).toBeUndefined()
    expect(typedValueOf(input({ type: 'datetime-local', value: '2026-11-03T09:30', defaultValue: '2026-11-03T09:30:00' }))).toBeUndefined()
    expect(typedValueOf(input({ type: 'checkbox', checked: true, defaultChecked: true }))).toBeUndefined()
    expect(typedValueOf(input({ type: 'file', files: [] }))).toBeUndefined()
  })

  it('judges a select by the option its markup selects, or the first enabled one', () => {
    const select = (selectedIndex: number, options: ReturnType<typeof option>[], size?: number) =>
      typedValueOf({ tagName: 'SELECT', value: String(selectedIndex), selectedIndex, options, size, ownerDocument: doc })

    expect(select(1, [option(''), option('0', true)])).toBeUndefined()
    expect(select(0, [option(''), option('0', true)])).toMatchObject({ kind: 'select', markup: '0', optionValues: ['', '0'] })
    expect(select(1, [option('', false, true), option('0')])).toBeUndefined()
    expect(select(2, [option('', false, true), option('0'), option('1')])).toMatchObject({ kind: 'select', markup: '0' })
    expect(select(-1, [option('0'), option('1')], 4)).toBeUndefined()
  })

  it('skips an option a disabled group holds', () => {
    const grouped = { ...option('0'), matches: (selectors: string) => selectors === ':disabled' }
    expect(typedValueOf({ tagName: 'SELECT', value: '1', selectedIndex: 1, options: [grouped, option('1')], ownerDocument: doc })).toBeUndefined()
  })

  it('reads no radio, hidden or button input, and nothing that is not a control', () => {
    for (const type of ['radio', 'hidden', 'submit', 'button']) expect(typedValueOf(input({ type, value: 'x' }))).toBeUndefined()
    expect(typedValueOf({ tagName: 'DIV', value: 'x', ownerDocument: doc })).toBeUndefined()
  })
})

describe('recordTypedValues', () => {
  it('leaves a value on the control that changed, taken once', () => {
    const edited = input({ value: 'typed' })
    const untouched = input({ value: 'kept', defaultValue: 'kept' })

    recordTypedValues({ querySelectorAll: () => [edited, untouched] })

    expect(takeTypedValue(edited)).toMatchObject({ value: 'typed' })
    expect(takeTypedValue(edited)).toBeUndefined()
    expect(takeTypedValue(untouched)).toBeUndefined()
  })
})

describe('adoptTypedValue', () => {
  it('sends the value through the control the field renders', () => {
    const text = field({ type: 'string', required: true }, '')
    const number = field({ type: 'number', required: true }, '')
    const checkbox = field({ type: 'boolean', required: false }, false)
    const select = field({ type: 'number', required: true, enum: [10, 20] }, 10)

    adoptTypedValue(text.state, typed({ value: 'typed' }))
    adoptTypedValue(number.state, typed({ type: 'number', value: '7', valueAsNumber: 7 }))
    adoptTypedValue(checkbox.state, typed({ kind: 'checkbox', type: 'checkbox', checked: true, markup: false }))
    adoptTypedValue(select.state, typed({ kind: 'select', type: 'select-one', value: '1', markup: '0', optionValues: ['', '0', '1'] }))

    expect([text.writes, number.writes, checkbox.writes, select.writes]).toEqual([['typed'], [7], [true], [20]])
  })

  it('leaves a control an app rendered its own way to the app', () => {
    const text = field({ type: 'string', required: true }, 'stored')
    const select = field({ type: 'string', required: true, enum: ['draft', 'published'] }, 'draft')

    adoptTypedValue(text.state, typed({ value: 'typed', markup: 'Stored (formatted)' }))
    adoptTypedValue(select.state, typed({ kind: 'select', type: 'select-one', value: 'published', markup: 'draft', optionValues: ['draft', 'published'] }))

    expect([...text.writes, ...select.writes]).toEqual([])
  })

  it('ignores a value read off another kind of control, and a hidden field', () => {
    const text = field({ type: 'string', required: true }, 'stored')
    const hidden = field({ type: 'string', required: true }, 'stored', 'hidden')

    adoptTypedValue(text.state, typed({ type: 'email', value: 'a@example.com', markup: 'stored' }))
    adoptTypedValue(text.state, typed({ kind: 'select', type: 'select-one', value: '0', markup: 'stored' }))
    adoptTypedValue(hidden.state, typed({ value: 'other', markup: 'stored' }))

    expect([...text.writes, ...hidden.writes]).toEqual([])
  })
})
