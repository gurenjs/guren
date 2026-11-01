// guren-ui: Field v1. `guren upgrade` replaces this file only while it is unedited.
import type { ReactNode } from 'react'
import { useField, type FieldForm, type FieldInput, type FieldOption, type FieldState, type FormDataType } from '@guren/inertia-client/forms'
import { Checkbox } from './Checkbox'
import { Input } from './Input'
import { Label } from './Label'
import { Select } from './Select'
import { Textarea } from './Textarea'

export interface FieldProps<TBody extends FormDataType<TBody>, K extends keyof TBody & string> {
  form: FieldForm<TBody>
  name: K
  label?: string
  as?: FieldInput
  hint?: string
  options?: FieldOption<TBody[K]>[]
  /** For a file input: submit every chosen file instead of the first. */
  multiple?: boolean
  className?: string
  /** Renders the control in place of the default one; the label, hint and error stay. */
  children?: (field: FieldState<TBody[K]>) => ReactNode
}

/** One form key: its label, its control, a hint and the server's error, wired by `useField`. */
export function Field<TBody extends FormDataType<TBody>, K extends keyof TBody & string>({
  form,
  name,
  className,
  children,
  ...overrides
}: FieldProps<TBody, K>) {
  const field = useField(form, name, overrides)
  if (field.input === 'hidden') return <input {...field.control} />

  return (
    <div className={className}>
      {field.input === 'checkbox' && !children ? <FieldCheckbox field={field} /> : <Label htmlFor={field.id}>{field.label}</Label>}
      {children ? children(field) : <FieldControl field={field} />}
      {field.hint && <p id={field.hintId} className="mt-1 text-sm text-g-text-2">{field.hint}</p>}
      {field.error && <p id={field.errorId} className="mt-1 text-sm text-g-danger">{field.error}</p>}
    </div>
  )
}

function FieldCheckbox<TValue>({ field }: { field: Extract<FieldState<TValue>, { input: 'checkbox' }> }) {
  const { type: _type, ...control } = field.control
  return <Checkbox {...control} label={field.label} />
}

function FieldControl<TValue>({ field }: { field: FieldState<TValue> }) {
  switch (field.input) {
    case 'checkbox':
    case 'hidden':
      return null
    case 'textarea':
      return <Textarea {...field.control} className="mt-1" />
    case 'select':
      return (
        <Select
          {...field.control}
          className="mt-1"
          options={[{ value: '', label: '' }, ...field.options.map((option, index) => ({ value: String(index), label: option.label }))]}
        />
      )
    default:
      return <Input {...field.control} className="mt-1" />
  }
}
