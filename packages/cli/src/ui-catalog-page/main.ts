// Bundled to one ES module that the app's Vite serves as `virtual:guren/ui-catalog-client`; `react` and
// `@inertiajs/react` stay imports, resolved from the app, and the entry passes `createRoot` in (the CLI has
// no react-dom types). Styled inline with the app's `--g-*` tokens, since Tailwind never scans this module.

import { App } from '@inertiajs/react'
import { Component, createElement as h, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import { UI_CATALOG_HEIGHT_MESSAGE } from '../dev-center-links'
import type { UiComponentName } from '../guren-css'
import { UI_CATALOG_VARIANTS } from '../ui-catalog-variants'

type Module = Record<string, unknown>
type AnyComponent = ComponentType<Record<string, unknown>>
type Loaders = Record<string, () => Promise<Module>>

interface Root {
  render(node: ReactNode): void
}

interface UiCatalogOptions {
  /** Whether the app has a stylesheet to load; without one the copies render unstyled. */
  styled: boolean
  loaders: Loaders
}

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }
const stack: CSSProperties = { display: 'grid', gap: '16px', maxWidth: '36rem' }
const caption: CSSProperties = { margin: '0 0 6px', font: '500 12px/1.6 var(--g-font-mono, monospace)', color: 'var(--g-text-2)' }
const note: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--g-warn)' }

function example(label: string, ...children: ReactNode[]): ReactNode {
  return h('div', { key: label }, h('p', { style: caption }, label), h('div', { style: row }, ...children))
}

function missingExport(component: string, name: string): ReactNode {
  return h('p', { style: note }, `${component}.tsx no longer exports ${name}, so the shipped examples cannot render it.`)
}

class Boundary extends Component<{ name: string; children?: ReactNode }, { error?: string }> {
  override state: { error?: string } = {}
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children
    return h('p', { style: note }, `${this.props.name} threw while rendering the shipped examples: ${this.state.error}`)
  }
}

const ALERT_TEXT: Record<string, string> = { ok: 'The post was saved.', warn: 'The draft has unsaved changes.', danger: 'The post could not be saved.' }

const prevent = (event: { preventDefault(): void }) => event.preventDefault()

const OPTIONS = [{ value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }]

/** Each takes the export named after its component; `missingExport()` stands in when the copy lost it. */
const DEMOS: Record<UiComponentName, (Shown: AnyComponent, module: Module) => ReactNode> = {
  Alert: (Alert) => h('div', { style: stack }, ...UI_CATALOG_VARIANTS.alertTones.map((tone) =>
    example(`tone="${tone}"`, h('div', { style: { flex: 1 } }, h(Alert, { tone }, ALERT_TEXT[tone]))))),
  Button(Button, module) {
    const buttonClass = typeof module.buttonClass === 'function' ? (module.buttonClass as (options: Record<string, unknown>) => string) : undefined
    return h('div', { style: { display: 'grid', gap: '16px' } },
      ...UI_CATALOG_VARIANTS.buttonVariants.map((variant) => example(`variant="${variant}"`,
        ...UI_CATALOG_VARIANTS.buttonSizes.map((size) => h(Button, { key: size, variant, size }, `Save · ${size}`)),
        h(Button, { key: 'disabled', variant, disabled: true }, 'disabled'))),
      example('block', h('div', { style: { width: '20rem' } }, h(Button, { block: true }, 'Sign in'))),
      buttonClass
        ? example('buttonClass() on a link', h('a', { href: '#', onClick: prevent, className: buttonClass({ variant: 'secondary' }) }, 'Edit post'))
        : missingExport('Button', 'buttonClass'))
  },
  Card: (Card) => h('div', { style: stack },
    example('as="section" with a title', h('div', { style: { flex: 1 } }, h(Card, { title: 'Recent posts' }, 'A section of the page.'))),
    example('as="article"', h('div', { style: { flex: 1 } }, h(Card, { as: 'article' }, 'One item of a list.')))),
  Checkbox: (Checkbox) => example('unchecked · checked · disabled',
    h(Checkbox, { key: 'off', label: 'Remember me' }),
    h(Checkbox, { key: 'on', label: 'Published', defaultChecked: true }),
    h(Checkbox, { key: 'disabled', label: 'Archived', disabled: true })),
  Field: (Field) => h(FieldExamples, { Field }),
  Input: (Input) => h('div', { style: stack },
    example('placeholder', h(Input, { placeholder: 'you@example.com', 'aria-label': 'Email' })),
    example('value', h(Input, { defaultValue: 'Hello, Guren', 'aria-label': 'Title' })),
    example('disabled', h(Input, { defaultValue: 'Read only', disabled: true, 'aria-label': 'Slug' })),
    example('aria-invalid (an error)', h(Input, { defaultValue: 'not-an-email', 'aria-invalid': true, 'aria-label': 'Email' }))),
  Label: (Label) => example('for a control', h(Label, { htmlFor: 'guren-ui-label-example' }, 'Title'),
    h('input', { id: 'guren-ui-label-example', type: 'text', style: { padding: '4px 8px', border: '1px solid var(--g-line-strong)', borderRadius: '4px' } })),
  Select: (Select) => h('div', { style: stack },
    example('options', h(Select, { options: OPTIONS, 'aria-label': 'Status' })),
    example('disabled', h(Select, { options: OPTIONS, disabled: true, 'aria-label': 'Status' })),
    example('aria-invalid (an error)', h(Select, { options: OPTIONS, 'aria-invalid': true, 'aria-label': 'Status' }))),
  Textarea: (Textarea) => h('div', { style: stack },
    example('placeholder', h(Textarea, { placeholder: 'Write something', rows: 3, 'aria-label': 'Body' })),
    example('disabled', h(Textarea, { defaultValue: 'Read only', rows: 2, disabled: true, 'aria-label': 'Body' })),
    example('aria-invalid (an error)', h(Textarea, { defaultValue: '', rows: 2, 'aria-invalid': true, 'aria-label': 'Body' }))),
}

const FIELD_HINT = 'Shown as the page heading.'
const FIELD_ERROR = 'The email field must be a valid email address.'

/** A plain form object, which `FieldForm` accepts: `useField` reads `data` and `errors` and writes through `setData`. */
function FieldExamples({ Field }: { Field: AnyComponent }): ReactNode {
  const [data, setState] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(UI_CATALOG_VARIANTS.fieldInputs.map((input) => [input, input === 'checkbox' ? false : input === 'email' ? 'not-an-email' : ''])))
  const form = { data, errors: { email: FIELD_ERROR }, setData: (name: string, value: unknown) => setState((current) => ({ ...current, [name]: value })) }
  return h('div', { style: stack }, ...UI_CATALOG_VARIANTS.fieldInputs.map((input) => {
    const extra = input === 'email' ? ' with an error' : input === 'text' ? ' with a hint' : ''
    return example(`as="${input}"${extra}`, h('div', { style: { flex: 1 } }, h(Field, {
      form,
      name: input,
      as: input,
      ...(input === 'text' ? { hint: FIELD_HINT } : {}),
      ...(input === 'select' ? { options: OPTIONS } : {}),
    })))
  }))
}

function section(name: string, body: ReactNode): ReactNode {
  return h('section', { key: name, id: name, style: { padding: '24px 0', borderTop: '1px solid var(--g-line)' } },
    h('h2', { style: { margin: '0 0 16px', font: '700 16px/1.4 var(--g-font-mono, monospace)', color: 'var(--g-heading)' } }, name),
    h(Boundary, { name }, body))
}

function demo(name: UiComponentName, module: Module | Error): ReactNode {
  if (module instanceof Error) return h('p', { style: note }, `${name}.tsx could not be loaded: ${module.message}`)
  const Shown = module[name]
  return typeof Shown === 'function' ? DEMOS[name](Shown as AnyComponent, module) : missingExport(name, name)
}

function catalog(modules: Map<string, Module | Error>, styled: boolean): AnyComponent {
  return function UiCatalog() {
    const sections = [...modules].map(([name, module]) => section(name, demo(name as UiComponentName, module)))
    return h('main', { style: { padding: '8px 24px 24px', background: 'var(--g-page)', color: 'var(--g-text)', fontFamily: 'var(--g-font-sans, sans-serif)' } },
      styled ? null : h('p', { style: note }, 'The app has no resources/css/app.css or guren.css, so the copies render unstyled.'),
      sections.length ? sections : h('p', { style: { color: 'var(--g-text-2)' } }, 'No copied components. Run `bunx guren add ui` to copy them.'))
  }
}

function reportHeight(): void {
  const send = () => window.parent.postMessage({ type: UI_CATALOG_HEIGHT_MESSAGE, height: document.documentElement.scrollHeight }, '*')
  new ResizeObserver(send).observe(document.body)
  send()
}

/** Loads each copy apart, so one that fails to import or render leaves the others on the page. */
export async function renderUiCatalog(container: HTMLElement | null, createRoot: (container: HTMLElement) => Root, options: UiCatalogOptions): Promise<void> {
  if (!container) return
  const entries = await Promise.all(Object.entries(options.loaders).map(async ([name, load]) => {
    try { return [name, await load()] as const } catch (error) { return [name, error instanceof Error ? error : new Error(String(error))] as const }
  }))
  const UiCatalog = catalog(new Map<string, Module | Error>(entries), options.styled)
  // `Field` reads the page through `usePage()`, which needs Inertia's page context: the catalog is the app's one page.
  const initialPage = {
    component: 'GurenUiCatalog',
    props: { errors: {} },
    url: `${location.pathname}${location.search}`,
    version: null,
    rescuedProps: [],
    flash: {},
    rememberedState: {},
  }
  createRoot(container).render(h(App, { initialPage, initialComponent: UiCatalog, resolveComponent: () => UiCatalog }))
  reportHeight()
}
