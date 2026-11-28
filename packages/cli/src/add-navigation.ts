/**
 * `guren add navigation` (RFC 0040 §5, "Existing applications"): `config/navigation.ts`, wired into
 * `createApp()`, for an app whose layout predates the navigation module, and the layout `guren add
 * auth` writes in place of one only when the app's copy is still a version the framework shipped.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { assertNotApiOnly } from './app-surface'
import { CliError } from './cli-error'
import { readIfExists } from './discovery'
import { uiComponentHash } from './guren-css'
import { loadRouteDefinitions } from './load-routes'
import { definesNavigation } from './make-auth'
import { wireConfig } from './provider-registrar'
import { DEFAULT_ROUTES_FILE } from './route-registrar'
import { navigationRouteNames } from './routes-types'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFileEntry } from './utils'

export const NAVIGATION_LAYOUT_FILE = 'resources/js/components/Layout.tsx'
const NAVIGATION_FILE = 'config/navigation.ts'
const LAYOUT_LANG_FILE = 'lang/en/layout.json'

/**
 * sha256 of every `Layout.tsx` a release's `guren add auth` wrote, the current template included,
 * read with LF line ends: a copy matching one is unedited, so it may be replaced. Append the hash
 * of each new template; `tests/add-navigation.test.ts` fails until the current one is listed.
 */
export const SHIPPED_LAYOUTS: ReadonlySet<string> = new Set([
  // v0.1.1-alpha.0 to v0.2.0-alpha.7
  '0cce4d79c3b286e532d16dffa04e62702c9b1946cbeb1abae9e573bfc83caaf9',
  // v1.0.0 to v1.6.0
  'e20d7ff3b1e588301a583b4b7a002c2f69f7ab1a1b80769d85c3750bebfb10dc',
  // v2.0.0 to v2.11.0
  'c09699d6f8dc4bbfe9b25480c5431094b1634cf980b3321d26043cf0c136e7e6',
  // v2.12.0 to v2.38.1
  'c138489f75b59b4a8106e943df1d3c3b5805b0185e7eb75c3035d72ba2ba11bc',
  // RFC 0040 §5: the navigation prop, the account labels, wide
  '0c1f3787db68319b23ae84ef8a60eebfbbe2d91ed5ab1a80cb23f9dda4dec0f8',
])

/** The starter entries and the route each needs a name for; one whose route the app does not name is left out. */
const STARTER_ENTRIES = [
  { route: 'home', line: "  { label: 'Home', route: 'home' },\n" },
  { route: 'dashboard', line: "  { label: 'Dashboard', route: 'dashboard', show: { auth: 'required' } },\n" },
] as const

/** `held`: a shipped version left in place, since the new one would not work in this app (`layoutHeld` says why). */
export type NavigationLayoutOutcome = 'replaced' | 'current' | 'kept' | 'absent' | 'held'

export interface AddNavigationResult {
  created: string[]
  /** `written` by this run, `kept` as a definition the app already had, `foreign` when that file is no `defineNavigation()`. */
  navigation: 'written' | 'kept' | 'foreign'
  layout: NavigationLayoutOutcome
  /** The starter entries left out, by route name, because the app names no such route. */
  omitted: string[]
  layoutHeld?: string
  /** Why the routes could not be read, when that is why entries were left out. */
  routesUnread?: string
}

/** No `cwd`: the layout is judged, written and wired in the one app the command runs in. */
export interface AddNavigationOptions {
  overwritten?: string[]
}

/** What the layout is to `add navigation`: replaceable only when it is a version a release wrote byte for byte. */
export function judgeNavigationLayout(current: string | null, template: string): NavigationLayoutOutcome {
  if (current === null) return 'absent'
  const hash = uiComponentHash(current)
  if (hash === uiComponentHash(template)) return 'current'
  return SHIPPED_LAYOUTS.has(hash) ? 'replaced' : 'kept'
}

interface AppRoutes {
  /** By the rule codegen types entries by. */
  names: readonly string[]
  /** `METHOD /path` of every route the routes file registers. */
  endpoints: ReadonlySet<string>
  /** Why the routes file could not be read, which is no answer about any name. */
  unread?: string
}

async function appRoutes(cwd: string): Promise<AppRoutes> {
  const routesFile = resolve(cwd, DEFAULT_ROUTES_FILE)
  if (!existsSync(routesFile)) return { names: [], endpoints: new Set(), unread: `there is no ${DEFAULT_ROUTES_FILE}` }
  try {
    const definitions = await loadRouteDefinitions(routesFile, cwd)
    return { names: navigationRouteNames(definitions), endpoints: new Set(definitions.map((route) => `${route.method.toUpperCase()} ${route.path}`)) }
  } catch (error) {
    return { names: [], endpoints: new Set(), unread: `${DEFAULT_ROUTES_FILE} could not be loaded (${error instanceof Error ? error.message : String(error)})` }
  }
}

/** The routes the auth layout links outside its entries; a layout an alpha `add auth` wrote ran without `/profile`. */
const ACCOUNT_ENDPOINTS = ['GET /login', 'GET /profile', 'POST /logout'] as const

/**
 * Whether the app's installed `pkg` names `exported` in the declarations its manifest points at; `null` when no copy
 * or no declaration file is found, which proves nothing. Walked from the app root up, as `node_modules` is resolved.
 */
async function installedDeclares(appRoot: string, pkg: string, exported: string): Promise<boolean | null> {
  for (let dir = resolve(appRoot); ; dir = dirname(dir)) {
    const root = join(dir, 'node_modules', pkg)
    const text = await readFile(join(root, 'package.json'), 'utf8').catch(() => undefined)
    if (text !== undefined) {
      try {
        const manifest = JSON.parse(text) as { types?: string; typings?: string; exports?: Record<string, unknown> }
        const entry = manifest.exports?.['.']
        const types = (typeof entry === 'object' && entry !== null ? (entry as { types?: unknown }).types : undefined) ?? manifest.types ?? manifest.typings
        if (typeof types !== 'string') return null
        const declarations = await readFile(join(root, types), 'utf8')
        return new RegExp(`\\b${exported}\\b`, 'u').test(declarations)
      } catch {
        return null
      }
    }
    if (dirname(dir) === dir) return null
  }
}

export async function addNavigation(options: AddNavigationOptions = {}): Promise<AddNavigationResult> {
  const cwd = process.cwd()
  await assertNotApiOnly(cwd, {
    does: 'guren add navigation writes the links of an Inertia layout',
    instead: 'An API-only app has no layout to render them',
  })
  // config/navigation.ts is imported at start, so an app on a server without the module would not boot.
  if ((await installedDeclares(cwd, '@guren/server', 'defineNavigation')) === false) {
    throw new CliError('The installed @guren/core exports no defineNavigation(), which config/navigation.ts imports. Upgrade the @guren packages (bunx guren upgrade), then run this again. Nothing was written.')
  }

  const routes = await appRoutes(cwd)
  const omitted: string[] = []
  const existingNavigation = await readIfExists(cwd, NAVIGATION_FILE)
  const navigation = existingNavigation === null ? 'written' : definesNavigation(existingNavigation) ? 'kept' : 'foreign'
  const files: ScaffoldFileEntry[] = []
  if (existingNavigation === null) {
    let contents = scaffoldTemplateFile('auth', NAVIGATION_FILE).contents
    for (const entry of STARTER_ENTRIES) {
      if (routes.names.includes(entry.route)) continue
      omitted.push(entry.route)
      contents = contents.replace(entry.line, '')
    }
    files.push({ path: NAVIGATION_FILE, contents })
  }

  const layoutTemplate = scaffoldTemplateFile('auth', NAVIGATION_LAYOUT_FILE)
  let layout = judgeNavigationLayout(await readIfExists(cwd, NAVIGATION_LAYOUT_FILE), layoutTemplate.contents)
  let layoutHeld: string | undefined
  if (layout === 'replaced') {
    const missing = ACCOUNT_ENDPOINTS.filter((endpoint) => !routes.endpoints.has(endpoint))
    if (navigation === 'foreign') layoutHeld = `${NAVIGATION_FILE} is no defineNavigation() definition, so nothing would share the links the new layout renders`
    else if (routes.unread) layoutHeld = `the account links it renders could not be checked: ${routes.unread}`
    else if (missing.length > 0) layoutHeld = `the new layout links ${missing.join(', ')}, which the routes file does not register`
    else if ((await installedDeclares(cwd, '@guren/inertia-client', 'hasTranslation')) === false) layoutHeld = 'the installed @guren/inertia-client exports no hasTranslation(), which the new layout imports; upgrade it first'
    if (layoutHeld) layout = 'held'
  }
  if (layout === 'replaced' && (await readIfExists(cwd, LAYOUT_LANG_FILE)) === null) files.push(scaffoldTemplateFile('auth', LAYOUT_LANG_FILE))

  // Each file is written apart: only the layout, judged unedited above, is written over.
  const created = files.length > 0 ? await writeScaffoldFiles(files, { overwritten: options.overwritten, subject: 'navigation' }) : []
  if (layout === 'replaced') created.push(...(await writeScaffoldFiles([layoutTemplate], { overwritten: options.overwritten, force: true, subject: 'navigation' })))

  if (navigation !== 'foreign') await wireConfig('navigation')

  return { created, navigation, layout, omitted, ...(layoutHeld ? { layoutHeld } : {}), ...(routes.unread && omitted.length > 0 ? { routesUnread: routes.unread } : {}) }
}

/** What the run leaves to the author: the layout's half when it was not replaced, and the entries it left out. */
export function navigationNextSteps(result: AddNavigationResult): string[] {
  const lines: string[] = []
  if (result.navigation === 'foreign') {
    lines.push(`${NAVIGATION_FILE} exists and is no defineNavigation() definition, so it was neither replaced nor wired into createApp().`)
  }
  if (result.layout === 'replaced') {
    lines.push(`Replaced ${NAVIGATION_LAYOUT_FILE}, a layout an earlier guren add auth wrote: it renders the navigation prop now, and a page passes wide for the wide measure.`)
  }
  if (result.layout === 'kept' || result.layout === 'absent' || result.layout === 'held') {
    lines.push(
      result.layout === 'kept'
        ? `${NAVIGATION_LAYOUT_FILE} is not a layout the framework shipped, so it was left as it is. Render the navigation prop in it:`
        : result.layout === 'held'
          ? `${NAVIGATION_LAYOUT_FILE} was left as it is, since ${result.layoutHeld}. Render the navigation prop in it:`
          : `There is no ${NAVIGATION_LAYOUT_FILE}. Render the navigation prop in your layout:`,
      "  import { Link, usePage } from '@inertiajs/react'",
      "  import type { NavigationItem } from '@guren/core'",
      '  // in the component:',
      '  const navigation = usePage<{ navigation?: NavigationItem[] }>().props.navigation ?? []',
      '  // in the header:',
      "  {navigation.map((item) => <Link key={item.path} href={item.path} aria-current={item.current ? 'page' : undefined}>{item.label}</Link>)}",
    )
  }
  if (result.routesUnread) lines.push(`The starter entries were left out, since ${result.routesUnread}: add them with bunx guren nav:add.`)
  for (const route of result.routesUnread ? [] : result.omitted) {
    lines.push(route === 'home'
      ? `No GET route with no path parameter is named home, so ${NAVIGATION_FILE} has no Home entry: name your / route with .name('home'), then run bunx guren nav:add "Home" --route home.`
      : `No GET route with no path parameter is named ${route}, so ${NAVIGATION_FILE} has no entry for it.`)
  }
  return lines
}
