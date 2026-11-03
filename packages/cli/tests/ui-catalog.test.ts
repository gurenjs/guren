import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describeUiComponent } from '../src/dev-center-page/ui'
import { UI_COMPONENTS, uiComponentPath, uiComponentTemplate, type UiComponentName } from '../src/guren-css'
import {
  bundleUiCatalogClient,
  readUiCatalog,
  UI_CATALOG_COMPONENT_PREFIX,
  UI_CATALOG_DEPENDENCIES,
  UI_CATALOG_ENTRY_ID,
  UI_CATALOG_PREVIEW_PATH,
  UI_CATALOG_STYLESHEET_ID,
  uiCatalogEntrySource,
  uiCatalogHtml,
  uiCatalogPreviewOrigin,
} from '../src/ui-catalog'
import { UI_CATALOG_VARIANTS } from '../src/ui-catalog-variants'
import { uiCatalogHooks, uiCatalogPrebundled } from '../src/vite/ui-catalog'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'guren-ui-catalog-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents)
}
const copy = (name: UiComponentName, contents = uiComponentTemplate(name)) => write(uiComponentPath(name), contents)

describe('readUiCatalog', () => {
  it('reports each shipped component by the rule guren upgrade applies', async () => {
    copy('Button')
    copy('Alert', `${uiComponentTemplate('Alert')}\nexport const extra = 1\n`)
    copy('Card', 'export function Card() { return null }\n')
    copy('Input', uiComponentTemplate('Input').replace(/\n/gu, '\r\n'))
    const catalog = await readUiCatalog(root, undefined)
    const byName = Object.fromEntries(catalog.components.map((component) => [component.name, component]))
    expect(catalog.components.map((component) => component.name)).toEqual([...UI_COMPONENTS])
    expect(byName.Button).toEqual({ name: 'Button', path: uiComponentPath('Button'), template: 'Button v1', state: 'current' })
    expect(byName.Input!.state).toBe('current')
    expect(byName.Alert).toMatchObject({ state: 'edited', claimed: 'Alert v1' })
    expect(byName.Card!.state).toBe('edited')
    expect(byName.Card!.claimed).toBeUndefined()
    expect(byName.Field!.state).toBe('missing')
  })

  it('names the preview on the Vite dev server, and why there is none without one', async () => {
    expect((await readUiCatalog(root, 'http://localhost:5173/')).preview).toEqual({ url: `http://localhost:5173${UI_CATALOG_PREVIEW_PATH}` })
    expect((await readUiCatalog(root, undefined)).preview).toHaveProperty('unavailable')
  })
})

describe('uiCatalogPreviewOrigin', () => {
  it('frames only an http or https origin', () => {
    expect(uiCatalogPreviewOrigin('http://127.0.0.1:5174/some/path')).toBe('http://127.0.0.1:5174')
    expect(uiCatalogPreviewOrigin('javascript:alert(1)')).toBeUndefined()
    expect(uiCatalogPreviewOrigin('not a url')).toBeUndefined()
    expect(uiCatalogPreviewOrigin('')).toBeUndefined()
  })
})

describe('the preview entry', () => {
  it('loads the app stylesheet and one loader per copy on disk', () => {
    write('resources/css/app.css', "@import 'tailwindcss';\n")
    write('resources/css/guren.css', ':root {}\n')
    copy('Button')
    copy('Field')
    const source = uiCatalogEntrySource(root)
    expect(source).toContain(`import '${UI_CATALOG_STYLESHEET_ID}'`)
    expect(source).toContain('styled: true')
    expect(source).toContain(`Button: () => import('${UI_CATALOG_COMPONENT_PREFIX}Button')`)
    expect(source).toContain(`Field: () => import('${UI_CATALOG_COMPONENT_PREFIX}Field')`)
    expect(source).not.toContain('Card:')
  })

  it('falls back to guren.css, then to no stylesheet', () => {
    write('resources/css/guren.css', ':root {}\n')
    expect(uiCatalogHooks(() => root).resolveId(UI_CATALOG_STYLESHEET_ID)).toBe(join(root, 'resources/css/guren.css'))
    rmSync(join(root, 'resources'), { recursive: true })
    expect(uiCatalogEntrySource(root)).toContain('styled: false')
    expect(uiCatalogEntrySource(root)).not.toContain(UI_CATALOG_STYLESHEET_ID)
  })

  it('is served by the Vite plugin under its virtual ids', () => {
    copy('Button')
    const hooks = uiCatalogHooks(() => root)
    const entry = hooks.resolveId(UI_CATALOG_ENTRY_ID)
    expect(entry).toBe(`\0${UI_CATALOG_ENTRY_ID}`)
    expect(hooks.load(entry!)).toBe(uiCatalogEntrySource(root))
    expect(hooks.resolveId('react')).toBeUndefined()
    expect(uiCatalogHtml()).toContain(`import '${UI_CATALOG_ENTRY_ID}'`)
  })

  // `routeTypesPlugin({ appRoot })` may name a root apart from Vite's, which a root-relative import would miss.
  it('resolves copies and the stylesheet to absolute files under the app root', () => {
    copy('Button')
    write('resources/css/app.css', '')
    const hooks = uiCatalogHooks(() => root)
    expect(hooks.resolveId(`${UI_CATALOG_COMPONENT_PREFIX}Button`)).toBe(join(root, uiComponentPath('Button')))
    expect(hooks.resolveId(UI_CATALOG_STYLESHEET_ID)).toBe(join(root, 'resources/css/app.css'))
    expect(hooks.resolveId(`${UI_CATALOG_COMPONENT_PREFIX}../../secret`)).toBeUndefined()
  })

  // Found on a request instead, each re-bundles and reloads, and a copy loaded in between can meet a second React.
  it('has Vite pre-bundle the preview\'s imports and every package a copy imports', async () => {
    copy('Button')
    copy('Field')
    copy('Card', [
      "import { z } from 'zod'",
      "import type { Schema } from 'types-only'",
      "import { helper } from '@/resources/js/lib/helper'",
      "import { Label } from './Label'",
      "import { readFileSync } from 'node:fs'",
      "export { format } from 'date-fns'",
      'export function Card() { return null }',
    ].join('\n'))
    copy('Select', 'export function Select( {')
    expect([...await uiCatalogPrebundled(root)].sort()).toEqual([...UI_CATALOG_DEPENDENCIES, '@guren/inertia-client/forms', 'zod', 'date-fns'].sort())
  })

  it('answers the preview path with the HTML Vite transformed', async () => {
    const handlers = new Map<string, (req: unknown, res: unknown, next: (error?: unknown) => void) => void>()
    const server = {
      middlewares: { use: (path: string, handler: (req: unknown, res: unknown, next: () => void) => void) => handlers.set(path, handler) },
      transformIndexHtml: async (_url: string, html: string) => `<!-- transformed -->${html}`,
      watcher: { on: () => undefined },
      moduleGraph: { getModuleById: () => undefined, invalidateModule: () => undefined },
    }
    uiCatalogHooks(() => root).configureServer(server as never)
    const sent: { headers: Record<string, string>; body?: string } = { headers: {} }
    const done = new Promise<void>((resolve) => {
      handlers.get(UI_CATALOG_PREVIEW_PATH)!(
        { method: 'GET', originalUrl: UI_CATALOG_PREVIEW_PATH },
        { setHeader: (name: string, value: string) => { sent.headers[name] = value }, end: (body: string) => { sent.body = body; resolve() } },
        () => resolve(),
      )
    })
    await done
    expect(sent.body).toStartWith('<!-- transformed --><!doctype html>')
    expect(sent.headers['Content-Type']).toBe('text/html; charset=utf-8')
  })
})

describe('the catalog client', () => {
  // Resolved by the app's Vite, so the catalog and the copies share one React and one Inertia.
  it('bundles to one module importing only react and @inertiajs/react', () => {
    const bundle = bundleUiCatalogClient(join(import.meta.dir, '../src/ui-catalog-page'))
    const imports = [...bundle.matchAll(/^import .* from "([^"]+)";?$/gmu)].map((match) => match[1]).sort()
    expect(imports).toEqual(['@inertiajs/react', 'react'])
    expect(bundle).toMatch(/export \{[^}]*renderUiCatalog/u)
  })

  it('lists every package the entry and the client import among the dependencies Vite pre-bundles', () => {
    copy('Button')
    const bundle = bundleUiCatalogClient(join(import.meta.dir, '../src/ui-catalog-page'))
    const sources = [uiCatalogEntrySource(root), bundle].join('\n')
    const packages = [...sources.matchAll(/^import .*?['"]([^'"]+)['"];?$/gmu)].map((match) => match[1]!).filter((id) => !id.startsWith('virtual:'))
    expect([...new Set(packages)].sort()).toEqual([...UI_CATALOG_DEPENDENCIES].sort())
  })
})

describe('UI_CATALOG_VARIANTS', () => {
  const union = (source: string, name: string) => {
    const body = new RegExp(`export type ${name} =([^\\n]*(?:\\n\\s+\\|[^\\n]*)*)`, 'u').exec(source)?.[1] ?? ''
    return [...body.matchAll(/'([a-z]+)'/gu)].map((match) => match[1]!)
  }

  it('shows every variant, size and tone the shipped templates export', () => {
    expect<string[]>([...UI_CATALOG_VARIANTS.buttonVariants]).toEqual(union(uiComponentTemplate('Button'), 'ButtonVariant'))
    expect<string[]>([...UI_CATALOG_VARIANTS.buttonSizes]).toEqual(union(uiComponentTemplate('Button'), 'ButtonSize'))
    expect<string[]>([...UI_CATALOG_VARIANTS.alertTones]).toEqual(union(uiComponentTemplate('Alert'), 'AlertTone'))
  })

  it('renders Field only with inputs the client accepts', () => {
    const client = union(readFileSync(join(import.meta.dir, '../../inertia-client/src/forms.ts'), 'utf8'), 'FieldInput')
    expect(client.length).toBeGreaterThan(5)
    expect(UI_CATALOG_VARIANTS.fieldInputs.filter((input: string) => !client.includes(input))).toEqual([])
  })
})

describe('describeUiComponent', () => {
  const base = { name: 'Button' as const, path: uiComponentPath('Button'), template: 'Button v1' }

  it('sends each state to the command that moves it', () => {
    expect(describeUiComponent({ ...base, state: 'current' })).toMatchObject({ tone: 'ok' })
    expect(describeUiComponent({ ...base, state: 'current' }).command).toBeUndefined()
    expect(describeUiComponent({ ...base, state: 'update' }).command).toBe('bunx guren upgrade')
    expect(describeUiComponent({ ...base, state: 'edited', claimed: 'Button v1' })).toMatchObject({ command: 'bunx guren add ui button --diff' })
    expect(describeUiComponent({ ...base, state: 'edited', claimed: 'Button v1' }).detail).toContain('Its header names Button v1')
    expect(describeUiComponent({ ...base, state: 'missing' }).command).toBe('bunx guren add ui button')
  })
})
