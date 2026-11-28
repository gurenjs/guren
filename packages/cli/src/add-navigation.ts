/**
 * `guren add navigation` (RFC 0040 §5, "Existing applications"): `config/navigation.ts`, wired into
 * `createApp()`, for an app whose layout predates the navigation module, and the layout `guren add
 * auth` writes in place of one only when the app's copy is still a version the framework shipped.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { assertNotApiOnly } from './app-surface'
import { readIfExists } from './discovery'
import { uiComponentHash } from './guren-css'
import { loadRouteDefinitions } from './load-routes'
import { definesNavigation } from './make-auth'
import { wireConfig } from './provider-registrar'
import { DEFAULT_ROUTES_FILE } from './route-registrar'
import { navigationRouteNames } from './routes-types'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeScaffoldFiles, type ScaffoldFileEntry, type WriterOptions } from './utils'

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

export type NavigationLayoutOutcome = 'replaced' | 'current' | 'kept' | 'absent'

export interface AddNavigationResult {
  created: string[]
  /** `written` by this run, `kept` as a definition the app already had, `foreign` when that file is no `defineNavigation()`. */
  navigation: 'written' | 'kept' | 'foreign'
  layout: NavigationLayoutOutcome
  /** The starter entries left out, by route name, because the app names no such route. */
  omitted: string[]
}

export interface AddNavigationOptions extends WriterOptions {
  overwritten?: string[]
}

/** What the layout is to `add navigation`: replaceable only when it is a version a release wrote byte for byte. */
export function judgeNavigationLayout(current: string | null, template: string): NavigationLayoutOutcome {
  if (current === null) return 'absent'
  const hash = uiComponentHash(current)
  if (hash === uiComponentHash(template)) return 'current'
  return SHIPPED_LAYOUTS.has(hash) ? 'replaced' : 'kept'
}

/** By the rule codegen types entries by, on the routes file it reads; a file that does not load names nothing. */
async function namedRoutes(cwd: string): Promise<readonly string[]> {
  const routesFile = resolve(cwd, DEFAULT_ROUTES_FILE)
  if (!existsSync(routesFile)) return []
  try {
    return navigationRouteNames(await loadRouteDefinitions(routesFile, cwd))
  } catch {
    return []
  }
}

export async function addNavigation(options: AddNavigationOptions = {}): Promise<AddNavigationResult> {
  const cwd = process.cwd()
  await assertNotApiOnly(cwd, {
    does: 'guren add navigation writes the links of an Inertia layout',
    instead: 'An API-only app has no layout to render them',
  })

  const files: ScaffoldFileEntry[] = []
  const omitted: string[] = []
  const existingNavigation = await readIfExists(cwd, NAVIGATION_FILE)
  if (existingNavigation === null) {
    const names = await namedRoutes(cwd)
    const file = scaffoldTemplateFile('auth', NAVIGATION_FILE)
    let contents = file.contents
    for (const entry of STARTER_ENTRIES) {
      if (names.includes(entry.route)) continue
      omitted.push(entry.route)
      contents = contents.replace(entry.line, '')
    }
    files.push({ path: NAVIGATION_FILE, contents })
  }

  const layoutTemplate = scaffoldTemplateFile('auth', NAVIGATION_LAYOUT_FILE)
  const layout = judgeNavigationLayout(await readIfExists(cwd, NAVIGATION_LAYOUT_FILE), layoutTemplate.contents)
  if (layout === 'replaced') {
    files.push(layoutTemplate)
    if ((await readIfExists(cwd, LAYOUT_LANG_FILE)) === null) files.push(scaffoldTemplateFile('auth', LAYOUT_LANG_FILE))
  }

  // The layout is replaced only when judged unedited above, so force reaches no file the app wrote.
  const created = files.length > 0 ? await writeScaffoldFiles(files, { ...options, force: layout === 'replaced', subject: 'navigation' }) : []

  const navigation = existingNavigation === null ? 'written' : definesNavigation(existingNavigation) ? 'kept' : 'foreign'
  if (navigation !== 'foreign') await wireConfig('navigation')

  return { created, navigation, layout, omitted }
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
  if (result.layout === 'kept' || result.layout === 'absent') {
    lines.push(
      result.layout === 'kept'
        ? `${NAVIGATION_LAYOUT_FILE} is not a layout the framework shipped, so it was left as it is. Render the navigation prop in it:`
        : `There is no ${NAVIGATION_LAYOUT_FILE}. Render the navigation prop in your layout:`,
      "  import type { NavigationItem } from '@guren/core'",
      '  const navigation = usePage<{ navigation?: NavigationItem[] }>().props.navigation ?? []',
      "  {navigation.map((item) => <Link key={item.path} href={item.path} aria-current={item.current ? 'page' : undefined}>{item.label}</Link>)}",
    )
  }
  for (const route of result.omitted) {
    lines.push(route === 'home'
      ? `No GET route with no path parameter is named home, so ${NAVIGATION_FILE} has no Home entry: name your / route with .name('home'), then run bunx guren nav:add "Home" --route home.`
      : `No GET route with no path parameter is named ${route}, so ${NAVIGATION_FILE} has no entry for it.`)
  }
  return lines
}
