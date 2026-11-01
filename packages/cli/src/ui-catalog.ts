// The component catalog: what the Dev Center's `/_guren/ui.json` reports about each copied component, and the
// preview page the CLI's Vite plugin serves, which renders the copies through the app's own Vite and stylesheet.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planAppUiComponents, UI_COMPONENTS, UI_COMPONENTS_DIR, uiComponentPath, uiComponentTemplate, uiComponentVersion, type UiComponentName } from './guren-css'
import { bundlePageScript } from './page-bundle'

/** Served by the app's Vite dev server, never by the app: only Vite can compile the app's Tailwind and `.tsx`. */
export const UI_CATALOG_PREVIEW_PATH = '/__guren/ui-catalog'
export const UI_CATALOG_ENTRY_ID = 'virtual:guren/ui-catalog'
export const UI_CATALOG_CLIENT_ID = 'virtual:guren/ui-catalog-client'
export const UI_CATALOG_ASSET = 'assets/ui-catalog/catalog.js'
/** The client imports these, resolved from the app so the catalog shares its React and Inertia. */
export const UI_CATALOG_EXTERNALS = ['react', '@inertiajs/react'] as const

/** `planUiComponent()`'s verdict on a copy, or `missing` for a component the app has not copied. */
export type UiCatalogState = 'current' | 'update' | 'edited' | 'missing'

export interface UiCatalogComponent {
  name: UiComponentName
  path: string
  /** The version this CLI's template header names, such as `Button v1`. */
  template?: string
  state: UiCatalogState
  /** For an edited copy: the version its own header names. */
  claimed?: string
}

export interface UiCatalog {
  schemaVersion: 1
  dir: string
  components: UiCatalogComponent[]
  preview: { url: string } | { unavailable: string }
}

/** Each shipped component and how the app's copy compares, judged by the rule `guren upgrade` applies. Throws when a copy cannot be read. */
export async function readUiCatalog(cwd: string, viteUrl: string | undefined): Promise<UiCatalog> {
  const plans = new Map((await planAppUiComponents(cwd)).map((entry) => [entry.name, entry.plan]))
  const components = UI_COMPONENTS.map((name): UiCatalogComponent => {
    const plan = plans.get(name)
    const template = uiComponentVersion(uiComponentTemplate(name))
    const base = { name, path: uiComponentPath(name), ...(template ? { template } : {}) }
    if (!plan) return { ...base, state: 'missing' }
    return plan.kind === 'edited' && plan.claimed ? { ...base, state: 'edited', claimed: plan.claimed } : { ...base, state: plan.kind }
  })
  return { schemaVersion: 1, dir: UI_COMPONENTS_DIR, components, preview: previewLocation(viteUrl) }
}

function previewLocation(viteUrl: string | undefined): UiCatalog['preview'] {
  const origin = uiCatalogPreviewOrigin(viteUrl)
  if (!origin) return { unavailable: 'No Vite dev server is running for this app (VITE_DEV_SERVER_URL is unset), so the copies cannot be rendered.' }
  return { url: `${origin}${UI_CATALOG_PREVIEW_PATH}` }
}

/** The Vite dev server's origin, or `undefined` for a missing or non-HTTP URL. The Dev Center frames only this origin. */
export function uiCatalogPreviewOrigin(viteUrl: string | undefined): string | undefined {
  if (!viteUrl) return undefined
  try {
    const url = new URL(viteUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch {
    return undefined
  }
}

export function uiCatalogHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Guren UI components</title>
  </head>
  <body>
    <div id="guren-ui-catalog"></div>
    <script type="module">import '${UI_CATALOG_ENTRY_ID}'</script>
  </body>
</html>
`
}

/** The stylesheet the app's own pages load: `app.css` imports Tailwind and `guren.css`, which alone styles nothing. */
export function uiCatalogStylesheet(root: string): string | undefined {
  return ['resources/css/app.css', 'resources/css/guren.css'].find((path) => existsSync(join(root, path)))
}

/**
 * The entry module: the stylesheet, one loader per copied component, and the client's render call. Every
 * path it writes comes from the closed lists above, never from the app, so each is quoted as it stands.
 */
export function uiCatalogEntrySource(root: string): string {
  const stylesheet = uiCatalogStylesheet(root)
  const loaders = UI_COMPONENTS.filter((name) => existsSync(join(root, uiComponentPath(name))))
    .map((name) => `  ${name}: () => import('/${uiComponentPath(name)}'),`)
  return [
    `import { createRoot } from 'react-dom/client'`,
    `import { renderUiCatalog } from '${UI_CATALOG_CLIENT_ID}'`,
    ...(stylesheet ? [`import '/${stylesheet}'`] : []),
    '',
    `renderUiCatalog(document.getElementById('guren-ui-catalog'), createRoot, {`,
    `  stylesheet: ${stylesheet ? `'${stylesheet}'` : 'null'},`,
    '  loaders: {',
    ...loaders,
    '  },',
    '})',
    '',
  ].join('\n')
}

export function bundleUiCatalogClient(pageDir: string): string {
  return bundlePageScript(pageDir, 'main.ts', 'component catalog', { format: 'esm', external: UI_CATALOG_EXTERNALS })
}

let client: string | undefined
/** The client as one ES module, bundled from source when run from source, else the copy the build wrote. */
export function uiCatalogClientSource(): string {
  if (client !== undefined) return client
  const pageDir = fileURLToPath(new URL('./ui-catalog-page/', import.meta.url))
  client = existsSync(pageDir)
    ? bundleUiCatalogClient(pageDir)
    : readFileSync(fileURLToPath(new URL(`../${UI_CATALOG_ASSET}`, import.meta.url)), 'utf8')
  return client
}
