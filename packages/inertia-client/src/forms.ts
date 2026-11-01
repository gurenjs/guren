/**
 * Form fields derived from a route's body schema (RFC 0036 §2.2). `guren codegen` writes one
 * `RouteFormContract` per body-bound route into `.guren/forms.gen.ts`; `useRouteForm` binds an
 * Inertia form to it and `useField` turns one key into label, control props and error state.
 * Markup stays in the app: the copied `Field` component renders what `useField` returns.
 */
import type { ChangeEvent } from 'react'
import { useEffect, useId, useRef } from 'react'
import type { FormDataErrors, FormDataKeys, FormDataType, Method } from '@inertiajs/core'
import { useForm, usePage } from '@inertiajs/react'
import type { InertiaFormProps, InertiaPrecognitiveFormProps } from '@inertiajs/react'
import { substituteRouteParams, type RoutePathParams } from './components'
import { findTranslation, type I18nPageProps } from './i18n'

export type { FormDataType } from '@inertiajs/core'

/** One body key as codegen reads it off the route's schema, request side. */
export interface FieldContract {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown'
  /** The key must be present: JSON Schema's `required`, not HTML's. */
  required: boolean
  nullable?: boolean
  format?: string
  /** For `format: 'date-time'`: whether the schema takes a `Date` (`z.date()`) or a string. */
  value?: 'Date' | 'string'
  enum?: readonly (string | number)[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  multipleOf?: number
}

export interface RouteFormContract<TName extends string, TMethod extends string, TPath extends string, TBody> {
  route: TName
  method: TMethod
  path: TPath
  fields: { [K in keyof TBody & string]?: FieldContract }
}

/** The plan view vocabulary (RFC 0030 `form.fields[].input`) plus three string formats. */
export type FieldInput =
  | 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'date' | 'datetime'
  | 'file' | 'hidden' | 'email' | 'url' | 'password'

type HasParams<TPath extends string> = RoutePathParams<TPath> extends Record<string, never> ? false : true

export type RouteFormOptions<TPath extends string> = {
  /**
   * Seed the form's errors once, on mount, from the page's shared `errors` prop: the
   * redirect-back of a visit this form did not make. Nothing falls back to them afterwards.
   */
  adoptPageErrors?: boolean
  errorBag?: string
} & (HasParams<TPath> extends true ? { params: RoutePathParams<TPath> } : { params?: undefined })

/** A tuple, so the options (and `params` in them) are required exactly when the path has parameters. */
export type RouteFormOptionsArgs<TPath extends string> =
  HasParams<TPath> extends true ? [options: RouteFormOptions<TPath>] : [options?: RouteFormOptions<TPath>]

export type RouteForm<TBody extends FormDataType<TBody>> = InertiaPrecognitiveFormProps<TBody> & {
  contract?: RouteFormContract<string, string, string, TBody>
  /** The data the form was created with, which decides how a blank control is sent. */
  initialData: Readonly<TBody>
  /**
   * An `onSubmit` handler: prevents the default and calls Inertia's own `submit()`. It sets the
   * form's `transform()` to normalize blank controls, replacing one the page set.
   */
  handleSubmit: (event?: { preventDefault(): void }) => void
}

export function useRouteForm<
  TName extends string,
  TMethod extends string,
  TPath extends string,
  TBody extends FormDataType<TBody>,
>(
  contract: RouteFormContract<TName, TMethod, TPath, TBody>,
  initial: TBody,
  ...args: RouteFormOptionsArgs<TPath>
): RouteForm<TBody> {
  const options = args[0] as RouteFormOptions<string> | undefined
  // Inertia keeps the endpoint its first render passed, so getters read the latest params.
  const endpoint = { method: contract.method, url: resolveRouteUrl(contract.path, options?.params) }
  const endpointRef = useRef(endpoint)
  endpointRef.current = endpoint
  const form = useForm<TBody>(
    () => endpointRef.current.method.toLowerCase() as Method,
    () => endpointRef.current.url,
    initial,
  )
  const initialRef = useRef(initial)
  const pageErrors = usePage().props.errors

  useEffect(() => {
    const adopted = options?.adoptPageErrors ? selectErrorBag(pageErrors, options.errorBag) : undefined
    if (adopted) form.setError(adopted as FormDataErrors<TBody>)
    // Once, on mount: a later page error belongs to whichever form made that visit.
  }, [])

  return {
    ...form,
    contract,
    initialData: initialRef.current,
    handleSubmit: (event) => {
      event?.preventDefault()
      form.transform((data) => normalizeBlankFields(contract.fields, data, initialRef.current))
      form.submit(options?.errorBag ? { errorBag: options.errorBag } : {})
    },
  }
}

/**
 * The page errors a form adopts: those under `errorBag` when one is named (Inertia nests a bag's
 * errors under its name), else the flat set. `undefined` when there are none to adopt.
 */
export function selectErrorBag(pageErrors: unknown, errorBag?: string): Record<string, unknown> | undefined {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  if (!isRecord(pageErrors)) return undefined
  const selected = errorBag ? pageErrors[errorBag] : pageErrors
  return isRecord(selected) && Object.keys(selected).length > 0 ? selected : undefined
}

/**
 * The contract's path with `params` substituted. An optional segment left without a value is
 * dropped; a required one throws, rather than submitting to a literal `/posts/:id`.
 */
export function resolveRouteUrl(path: string, params?: Record<string, string | number>): string {
  const substituted = substituteRouteParams(path, params)
    .replace(/\/:[A-Za-z0-9_-]+(?:\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\})?\?/gu, '')
  const unresolved = /(?:^|\/):([A-Za-z0-9_-]+)/u.exec(substituted)
  if (unresolved) {
    throw new Error(`useRouteForm: no value for the path parameter ":${unresolved[1]}" in ${path}.`)
  }
  return substituted === '' ? '/' : substituted
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/**
 * What a blank (`''`) control submits (RFC 0036 §2.2): `null` for a nullable key; for an optional
 * one, nothing when it started blank and `''` when the user cleared it, so an update route never
 * reads a cleared value as "unchanged"; `''` for a required one, which the server judges.
 */
export function normalizeBlankFields<TBody extends object>(
  fields: { [K in keyof TBody & string]?: FieldContract },
  data: TBody,
  initial: Readonly<TBody>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  for (const [name, field] of Object.entries(fields) as [string, FieldContract | undefined][]) {
    if (!field || normalized[name] !== '') continue
    if (field.nullable) normalized[name] = null
    else if (!field.required && isBlank((initial as Record<string, unknown>)[name])) delete normalized[name]
  }
  return normalized
}

/** The default label for a field name: `startsAt` and `starts_at` both give "Starts at". */
export function humanizeFieldName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .split(/[\s_\-.]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
  const sentence = words.join(' ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

/** A key the translator can reach as one segment: it splits on `.` and stops at a string. */
function isKeySegment(segment: string): boolean {
  return segment !== '' && !segment.includes('.')
}

/**
 * A field's label when the caller passes none (RFC 0036 §4): `fields.<route>.<name>.label`, then
 * `fields.<name>.label`, both in the current locale before the fallback, then
 * `humanizeFieldName(name)`. An empty translation is skipped: it would leave the control unnamed.
 */
export function resolveFieldLabel(name: string, i18n?: I18nPageProps, route?: string): string {
  const keys = isKeySegment(name) ? [...(route ? [`fields.${route}.${name}.label`] : []), `fields.${name}.label`] : []
  return findTranslation(i18n, keys) ?? humanizeFieldName(name)
}

/**
 * An enum member's option label: `fields.<name>.options.<value>`, then `humanizeFieldName()`. A
 * value with a dot (`1.5`) has no translation key, so it reads humanized unless the caller passes options.
 */
export function resolveOptionLabel(name: string, value: string | number, i18n?: I18nPageProps): string {
  const segment = String(value)
  const keys = isKeySegment(name) && isKeySegment(segment) ? [`fields.${name}.options.${segment}`] : []
  return findTranslation(i18n, keys) ?? humanizeFieldName(segment)
}

/**
 * The input kind a contract field derives when the caller passes no `as`. `textarea`,
 * `password`, `file` and `hidden` cannot be read off a schema; nor can a type the walker
 * could not see through, which falls back to a text input.
 */
export function deriveFieldInput(field: FieldContract | undefined): FieldInput {
  if (!field) return 'text'
  if (field.type === 'boolean') return 'checkbox'
  if (field.enum && field.enum.length > 0) return 'select'
  if (field.type === 'integer' || field.type === 'number') return 'number'
  if (field.type === 'string') {
    switch (field.format) {
      case 'email': return 'email'
      case 'uri': return 'url'
      case 'date': return 'date'
      case 'date-time': return 'datetime'
      default: return 'text'
    }
  }
  return 'text'
}

/**
 * HTML `required`: the control must be non-empty. Set when the key is not nullable and its schema
 * rejects `''` (anything but a string without `minLength >= 1`), and either the key is required
 * or the field starts with a value, since such a schema has no way to say "cleared".
 */
export function requiresValue(field: FieldContract | undefined, input: FieldInput, initialValue: unknown): boolean {
  if (!field || field.nullable || input === 'checkbox' || input === 'hidden') return false
  if (field.type === 'string' && !(field.minLength !== undefined && field.minLength >= 1)) return false
  return field.required || !isBlank(initialValue)
}

/**
 * `min`, `max` and `step` for a number control. The browser counts steps from `min`, so `min` is
 * raised to the first multiple of the step: `min={1} step={2}` would accept 3 and reject 2.
 */
export function numberAttributes(contract: FieldContract | undefined): { min?: number; max?: number; step: number | 'any' } {
  // Without `any` the browser's default step of 1 rejects `1.5`.
  const step = contract?.multipleOf ?? (contract?.type === 'integer' ? 1 : 'any')
  const minimum = contract?.minimum
  const min = minimum === undefined || step === 'any' ? minimum : Number((Math.ceil(minimum / step - 1e-9) * step).toPrecision(12))
  return {
    ...(min !== undefined ? { min } : {}),
    ...(contract?.maximum !== undefined ? { max: contract.maximum } : {}),
    step,
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** A stored timestamp (ISO string or `Date`) as the local `YYYY-MM-DDTHH:mm[:ss]` a `datetime-local` control takes. */
export function toDateTimeLocal(value: unknown): string {
  if (isBlank(value)) return ''
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : ''
  const minutes = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
  return hasSeconds(date) ? `${minutes}:${pad(date.getSeconds())}` : minutes
}

function hasSeconds(date: Date): boolean {
  return date.getSeconds() !== 0 || date.getMilliseconds() !== 0
}

/** A `datetime-local` value read back as the instant it names, in the shape the contract takes. */
export function fromDateTimeLocal(local: string, valueKind: FieldContract['value']): Date | string {
  if (local === '') return ''
  const date = new Date(local)
  if (Number.isNaN(date.getTime())) return local
  return valueKind === 'Date' ? date : date.toISOString()
}

type Aria = { 'aria-invalid'?: true; 'aria-describedby'?: string }

type ControlBase = { id: string; name: string } & Aria

type TextLikeInput = 'text' | 'email' | 'url' | 'password' | 'number' | 'date' | 'datetime'

export type FieldOption<TValue> = { value: TValue; label: string }

interface FieldStateBase {
  id: string
  name: string
  label: string
  required: boolean
  error?: string
  errorId: string
  hint?: string
  hintId: string
}

export type FieldState<TValue> =
  | (FieldStateBase & {
      input: 'checkbox'
      control: ControlBase & { type: 'checkbox'; checked: boolean; onChange: (event: ChangeEvent<HTMLInputElement>) => void }
    })
  | (FieldStateBase & {
      input: 'select'
      options: FieldOption<TValue>[]
      /** `value` is the chosen option's index, so each maps back to its original member. */
      control: ControlBase & { value: string; required?: boolean; onChange: (event: ChangeEvent<HTMLSelectElement>) => void }
    })
  | (FieldStateBase & {
      input: 'file'
      control: ControlBase & { type: 'file'; multiple?: boolean; required?: boolean; onChange: (event: ChangeEvent<HTMLInputElement>) => void }
    })
  | (FieldStateBase & {
      input: 'hidden'
      control: { id: string; name: string; type: 'hidden'; value: string }
    })
  | (FieldStateBase & {
      input: 'textarea'
      control: ControlBase & {
        value: string
        required?: boolean
        minLength?: number
        maxLength?: number
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void
      }
    })
  | (FieldStateBase & {
      input: TextLikeInput
      control: ControlBase & {
        type: 'text' | 'email' | 'url' | 'password' | 'number' | 'date' | 'datetime-local'
        value: string
        required?: boolean
        minLength?: number
        maxLength?: number
        min?: number
        max?: number
        step?: number | 'any'
        onChange: (event: ChangeEvent<HTMLInputElement>) => void
      }
    })

export interface FieldOverrides<TValue> {
  label?: string
  as?: FieldInput
  hint?: string
  options?: FieldOption<TValue>[]
  /** For a file input: submit every chosen file instead of the first. */
  multiple?: boolean
}

/** What `useField` reads a key from: a route form, or a plain Inertia form that derives nothing. */
export type FieldForm<TBody extends FormDataType<TBody>> = RouteForm<TBody> | InertiaFormProps<TBody>

/**
 * One body key's label, control props and error state. A plain Inertia form works too: with no
 * contract nothing is derived, the input comes from `as` (default `text`) and the label from
 * `label`, a `fields.<name>.label` translation, or the field name. Translations come from the
 * `_i18n` page prop, read without `useTranslation()`'s warning since most apps share none.
 */
export function useField<TBody extends FormDataType<TBody>, K extends keyof TBody & string>(
  form: FieldForm<TBody>,
  name: K,
  overrides: FieldOverrides<TBody[K]> = {},
): FieldState<TBody[K]> {
  const id = `field-${useId()}-${name}`
  const routeForm = 'handleSubmit' in form ? form : undefined
  const contract = routeForm?.contract?.fields[name]
  const initialValue = routeForm ? (routeForm.initialData as Record<string, unknown>)[name] : undefined
  const i18n = usePage().props._i18n as I18nPageProps | undefined
  return describeField({
    id,
    name,
    value: form.data[name],
    error: form.errors[name as keyof typeof form.errors] as string | undefined,
    contract,
    initialValue,
    overrides,
    i18n,
    ...(routeForm?.contract ? { route: routeForm.contract.route } : {}),
    setValue: (value) => form.setData(name as FormDataKeys<TBody>, value as never),
  })
}

export interface DescribeFieldInput<TValue> {
  id: string
  name: string
  value: unknown
  error?: string
  contract?: FieldContract
  initialValue?: unknown
  overrides?: FieldOverrides<TValue>
  /** The `_i18n` page prop, for translated labels. */
  i18n?: I18nPageProps
  /** The contract's route name, for `fields.<route>.<name>.label`. */
  route?: string
  setValue: (value: unknown) => void
}

/** `useField` without the hooks: everything it returns is computed here. */
export function describeField<TValue>(input: DescribeFieldInput<TValue>): FieldState<TValue> {
  const { id, name, value, error, contract, initialValue, overrides = {}, i18n, route, setValue } = input
  const kind = overrides.as ?? deriveFieldInput(contract)
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [overrides.hint ? hintId : undefined, error ? errorId : undefined].filter(Boolean).join(' ')
  const aria: Aria = {
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  }
  const required = requiresValue(contract, kind, initialValue)
  const base: FieldStateBase = {
    id,
    name,
    label: overrides.label ?? resolveFieldLabel(name, i18n, route),
    required,
    ...(error ? { error } : {}),
    errorId,
    ...(overrides.hint ? { hint: overrides.hint } : {}),
    hintId,
  }
  const requiredProp = required ? { required: true } : {}
  const lengths = {
    ...(contract?.minLength !== undefined ? { minLength: contract.minLength } : {}),
    ...(contract?.maxLength !== undefined ? { maxLength: contract.maxLength } : {}),
  }

  switch (kind) {
    case 'checkbox':
      return {
        ...base,
        input: 'checkbox',
        control: { id, name, ...aria, type: 'checkbox', checked: value === true, onChange: (event) => setValue(event.target.checked) },
      }
    case 'select': {
      const options = overrides.options
        ?? (contract?.enum ?? []).map((member) => ({ value: member as TValue, label: resolveOptionLabel(name, member, i18n) }))
      const index = options.findIndex((option) => option.value === value)
      return {
        ...base,
        input: 'select',
        options,
        control: {
          id,
          name,
          ...aria,
          ...requiredProp,
          value: index === -1 ? '' : String(index),
          onChange: (event) => {
            const chosen = options[Number(event.target.value)]
            setValue(event.target.value === '' || !chosen ? '' : chosen.value)
          },
        },
      }
    }
    case 'file':
      return {
        ...base,
        input: 'file',
        control: {
          id,
          name,
          ...aria,
          ...requiredProp,
          type: 'file',
          ...(overrides.multiple ? { multiple: true } : {}),
          onChange: (event) => {
            const files = event.target.files
            setValue(overrides.multiple ? Array.from(files ?? []) : (files?.[0] ?? null))
          },
        },
      }
    case 'hidden':
      return { ...base, input: 'hidden', control: { id, name, type: 'hidden', value: isBlank(value) ? '' : String(value) } }
    case 'textarea':
      return {
        ...base,
        input: 'textarea',
        control: { id, name, ...aria, ...requiredProp, ...lengths, value: isBlank(value) ? '' : String(value), onChange: (event) => setValue(event.target.value) },
      }
    case 'number':
      return {
        ...base,
        input: 'number',
        control: {
          id,
          name,
          ...aria,
          ...requiredProp,
          type: 'number',
          value: isBlank(value) ? '' : String(value),
          ...numberAttributes(contract),
          onChange: (event) => setValue(Number.isNaN(event.target.valueAsNumber) ? '' : event.target.valueAsNumber),
        },
      }
    case 'date':
      return {
        ...base,
        input: 'date',
        control: {
          id,
          name,
          ...aria,
          ...requiredProp,
          type: 'date',
          value: isBlank(value) ? '' : (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10),
          onChange: (event) => setValue(event.target.value === '' || contract?.value !== 'Date' ? event.target.value : new Date(event.target.value)),
        },
      }
    case 'datetime': {
      const local = toDateTimeLocal(value)
      const showsSeconds = local.length > 16
      return {
        ...base,
        input: 'datetime',
        control: {
          id,
          name,
          ...aria,
          ...requiredProp,
          type: 'datetime-local',
          value: local,
          ...(showsSeconds ? { step: 1 } : {}),
          onChange: (event) => setValue(fromDateTimeLocal(event.target.value, contract?.value)),
        },
      }
    }
    default:
      return {
        ...base,
        input: kind,
        control: {
          id,
          name,
          ...aria,
          ...requiredProp,
          ...lengths,
          type: kind,
          value: isBlank(value) ? '' : String(value),
          onChange: (event) => setValue(event.target.value),
        },
      }
  }
}
