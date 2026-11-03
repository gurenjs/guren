/**
 * What a reader typed into a server-rendered form before the client loaded. The default setup
 * records it on each control just before `hydrateRoot()`, which rewrites a textarea's value, and
 * `useField` takes it once when its control hydrates. A client-rendered control never carries one.
 * The key is a registered symbol, so a second bundled copy of this module reads the same records.
 */
import type { FieldState } from './forms'

const TYPED = Symbol.for('guren.typedBeforeHydration')

export interface TypedValue {
  kind: 'checkbox' | 'file' | 'select' | 'textarea' | 'input'
  /** The input's `type`, which the field's control has to share. */
  type: string
  value: string
  valueAsNumber: number
  checked: boolean
  files: ArrayLike<unknown> | null
}

interface ControlLike {
  tagName: string
  type?: string
  value?: string
  defaultValue?: string
  valueAsNumber?: number
  checked?: boolean
  defaultChecked?: boolean
  multiple?: boolean
  options?: ArrayLike<{ defaultSelected: boolean; disabled: boolean }>
  selectedIndex?: number
  files?: ArrayLike<unknown> | null
  ownerDocument: { createElement(tag: string): { type?: string; value: string } }
}

type Recorded = { [TYPED]?: TypedValue }

/** Records every control in `container` whose state differs from what the server rendered. */
export function recordTypedValues(container: { querySelectorAll(selectors: string): ArrayLike<object> }): void {
  for (const element of Array.from(container.querySelectorAll('input, select, textarea'))) {
    const typed = typedValueOf(element as ControlLike)
    if (typed) (element as Recorded)[TYPED] = typed
  }
}

export function takeTypedValue(element: object): TypedValue | undefined {
  const typed = (element as Recorded)[TYPED]
  delete (element as Recorded)[TYPED]
  return typed
}

/**
 * The control's state, when it differs from what its markup describes. A text value is compared
 * after the browser sanitizes the default too (a fresh control is handed it), since a
 * `datetime-local` drops `:00` seconds; a `<select>` with no `selected` option shows its first one.
 */
export function typedValueOf(element: ControlLike): TypedValue | undefined {
  const fresh = (tag: string) => element.ownerDocument.createElement(tag)
  switch (element.tagName) {
    case 'TEXTAREA': {
      const probe = fresh('textarea')
      probe.value = element.defaultValue ?? ''
      return element.value === probe.value ? undefined : snapshot('textarea', element)
    }
    case 'SELECT': {
      if (element.multiple) return undefined
      const options = Array.from(element.options ?? [])
      const marked = options.map((option) => option.defaultSelected).lastIndexOf(true)
      const initial = marked === -1 ? options.findIndex((option) => !option.disabled) : marked
      return element.selectedIndex === initial ? undefined : snapshot('select', element)
    }
    case 'INPUT':
      break
    default:
      return undefined
  }
  switch (element.type) {
    case 'checkbox':
      return element.checked === element.defaultChecked ? undefined : snapshot('checkbox', element)
    case 'file':
      return element.files && element.files.length > 0 ? snapshot('file', element) : undefined
    case 'radio':
    case 'hidden':
    case 'submit':
    case 'reset':
    case 'button':
    case 'image':
      return undefined
  }
  const probe = fresh('input')
  probe.type = element.type ?? 'text'
  probe.value = element.defaultValue ?? ''
  return element.value === probe.value ? undefined : snapshot('input', element)
}

/** Sends a recorded value through the field's own `onChange`, when the field renders that kind of control. */
export function adoptTypedValue<TValue>(field: FieldState<TValue>, typed: TypedValue): void {
  if (field.input === 'hidden') return
  const matches = field.input === 'checkbox' || field.input === 'file' || field.input === 'select' || field.input === 'textarea'
    ? typed.kind === field.input
    : typed.kind === 'input' && typed.type === field.control.type
  if (matches) field.control.onChange({ target: typed, currentTarget: typed } as never)
}

function snapshot(kind: TypedValue['kind'], element: ControlLike): TypedValue {
  return {
    kind,
    type: element.type ?? '',
    value: element.value ?? '',
    valueAsNumber: element.valueAsNumber ?? Number.NaN,
    checked: element.checked ?? false,
    files: element.files ?? null,
  }
}
