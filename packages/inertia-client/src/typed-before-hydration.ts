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
  /** What the markup held: the `value` attribute, a textarea's text, a select's default option, or `defaultChecked`. */
  markup: string | boolean
  /** A select's option values, in order. */
  optionValues: string[]
}

interface OptionLike {
  value: string
  defaultSelected: boolean
  disabled: boolean
  /** `:disabled` also covers an option inside a disabled `<optgroup>`. */
  matches?: (selectors: string) => boolean
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
  size?: number
  options?: ArrayLike<OptionLike>
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
  const sanitized = (tag: string, type?: string) => {
    const probe = element.ownerDocument.createElement(tag)
    if (type) probe.type = type
    probe.value = element.defaultValue ?? ''
    return probe.value
  }
  switch (element.tagName) {
    case 'TEXTAREA':
      return element.value === sanitized('textarea') ? undefined : snapshot('textarea', element, element.defaultValue ?? '')
    case 'SELECT': {
      if (element.multiple) return undefined
      const options = Array.from(element.options ?? [])
      const initial = initialOption(options, (element.size ?? 0) > 1)
      if (element.selectedIndex === initial) return undefined
      return snapshot('select', element, options[initial]?.value ?? '', options.map((option) => option.value))
    }
    case 'INPUT':
      break
    default:
      return undefined
  }
  switch (element.type) {
    case 'checkbox':
      return element.checked === element.defaultChecked ? undefined : snapshot('checkbox', element, element.defaultChecked ?? false)
    case 'file':
      return element.files && element.files.length > 0 ? snapshot('file', element, '') : undefined
    case 'radio':
    case 'hidden':
    case 'submit':
    case 'reset':
    case 'button':
    case 'image':
      return undefined
  }
  const type = element.type ?? 'text'
  return element.value === sanitized('input', type) ? undefined : snapshot('input', element, element.defaultValue ?? '')
}

/**
 * Sends a recorded value through the field's own `onChange`, when the field's control rendered
 * that markup: the same kind, the field's value as its default, and for a select the field's
 * index-valued options. A control an app renders its own way keeps the app's handler.
 */
export function adoptTypedValue<TValue>(field: FieldState<TValue>, typed: TypedValue): void {
  if (field.input !== 'hidden' && renderedBy(field, typed)) field.control.onChange({ target: typed, currentTarget: typed } as never)
}

function renderedBy<TValue>(field: FieldState<TValue>, typed: TypedValue): boolean {
  switch (field.input) {
    case 'hidden':
      return false
    case 'checkbox':
      return typed.kind === 'checkbox' && typed.markup === field.control.checked
    case 'file':
      return typed.kind === 'file'
    case 'select': {
      const indices = ['', ...field.options.map((_, index) => String(index))]
      return typed.kind === 'select'
        && typed.markup === field.control.value
        && typed.optionValues.length === indices.length
        && typed.optionValues.every((value, index) => value === indices[index])
    }
    case 'textarea':
      return typed.kind === 'textarea' && typed.markup === field.control.value
    default:
      return typed.kind === 'input' && typed.type === field.control.type && typed.markup === field.control.value
  }
}

/** The option a select shows before anyone touches it: the last one marked `selected`, else the first enabled one (none in a list box). */
function initialOption(options: OptionLike[], listBox: boolean): number {
  const marked = options.map((option) => option.defaultSelected).lastIndexOf(true)
  if (marked !== -1 || listBox) return marked
  return options.findIndex((option) => !(option.matches ? option.matches(':disabled') : option.disabled))
}

function snapshot(kind: TypedValue['kind'], element: ControlLike, markup: string | boolean, optionValues: string[] = []): TypedValue {
  return {
    kind,
    type: element.type ?? '',
    value: element.value ?? '',
    valueAsNumber: element.valueAsNumber ?? Number.NaN,
    checked: element.checked ?? false,
    files: element.files ?? null,
    markup,
    optionValues,
  }
}
