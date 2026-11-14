/**
 * The behaviour specs `guren browser:map` keeps under `tests/browser/behaviours/generated/` (RFC 0033
 * §13.5), pure: one e2e test per plan behaviour a view of the plan sends. The test opens the start
 * page, one agent step performs the behaviour, and locators pin the outcome. A behaviour it cannot
 * write is a skipped test naming why, never a pass. A title carries the id without brackets (§8)
 * and a digest of what was generated, so a changed test records anew and repairs nothing.
 */

import { createHash } from 'node:crypto'

import { isParameterless, type ApprovedPlanInput, type BrowserMap, type BrowserMapRoute, type BrowserMapView } from './browser-map'
import { GENERATED_HEADER, LOCALE_COOKIE } from './browser-specs'
import { CliError } from './cli-error'
import { routeTarget } from './plan/app-targets'
import { planSlug } from './plan/beside'
import type { Plan, PlanAcceptance, PlanView } from './plan/schema'
import { quoteString } from './schema-columns'
import { compareStrings } from './spec-artifact'
import type { ScaffoldFileEntry } from './utils'

export const BEHAVIOURS_CONFIG = 'e2e.browser.config.ts'
export const BEHAVIOURS_DIR = 'tests/browser/behaviours'
export const BEHAVIOURS_SETUP = `${BEHAVIOURS_DIR}/auth.setup.e2e.ts`
/** Author-owned and written once: each behaviour's data and path parameters. Every generated spec imports it. */
export const BEHAVIOURS_GIVEN_FILE = `${BEHAVIOURS_DIR}/given.ts`
export const GENERATED_BEHAVIOURS_DIR = `${BEHAVIOURS_DIR}/generated`
/** The runner and its browser engine: `browser:map` writes a behaviour spec only for an app declaring both. */
export const BEHAVIOUR_PACKAGES = ['e2e', '@e2e-dev/web'] as const
/** The session the auth setup saves and a signed-in test runs under. */
export const BEHAVIOUR_SESSION = 'browser'

export interface BehaviourSpecOptions {
  /** The setup test signs in, so a route requiring a user can be driven. */
  signIn: boolean
}

interface BehaviourCase {
  title: string
  /** Absent for a skipped test, whose title says why. */
  body?: string[]
  signedIn?: boolean
  screen?: boolean
  /** Input keys the sending view's form has no label for. */
  unlabelled?: string[]
}

type Primitive = string | number | boolean

const REASONS = {
  kind: 'needs a second actor, a missing record or a state the plan words in prose; TestApp pins it',
  get: 'its route is a GET, which the smoke and view specs open',
  noView: 'no view of the plan sends its route, so nothing says which page to start on',
  signIn: 'needs a signed-in user, and the app has no password sign-in for the setup test',
  outcome: 'no outcome a browser can check: every expectation is a status or a database row, an errors key has no labelled field, or the view it lands on has no label and no action',
  input: 'an input is not a string, a number or a boolean, and nothing says how a control takes it',
  required: "leaves a required field empty, so the browser stops the submit and no error is rendered; TestApp pins it",
} as const

const PARAMETER = /^:([A-Za-z_][A-Za-z0-9_]*)/u

function parameterOf(segment: string): string | undefined {
  return PARAMETER.exec(segment)?.[1]
}

/** Prose in a title: a bracketed token there would read as a plan's test id (RFC 0033 §8). */
function unbracketed(text: string): string {
  return text.replaceAll(/[[\]]/gu, '')
}

/** A label inside an instruction: its quotes end the quoted name, and braces read as a parameter. */
function spoken(label: string): string {
  return label.replaceAll('"', "'").replaceAll('{', '(').replaceAll('}', ')')
}

function visible(locator: string): string {
  return `await expect(${locator}.first()).toBeVisible()`
}

function labelLocator(label: string): string {
  return `screen.getByLabel(${quoteString(label)}, { exact: true })`
}

/** The plan names an action, not its element: either a button or a link satisfies it. */
function actionLocator(label: string): string {
  return `screen.getByRole('button', ${quoteString(label)}).or(screen.getByRole('link', ${quoteString(label)}))`
}

function decode(json: string): unknown {
  return JSON.parse(json) as unknown
}

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function literal(value: Primitive): string {
  return typeof value === 'string' ? quoteString(value) : String(value)
}

/** The view that sends `route`: one whose form submits to it, else one with an action for it. */
function sendingView(views: readonly PlanView[], route: string): PlanView | undefined {
  const live = views.filter((view) => view.change.kind !== 'drop').sort((a, b) => compareStrings(a.id, b.id))
  return live.find((view) => view.form?.submitsTo === route) ?? live.find((view) => view.actions.some((action) => action.route === route))
}

/** A required key of the form the input leaves out, empty or null: the control carries `required`. */
function emptyRequiredField(plan: Plan, view: PlanView, inputs: ReadonlyMap<string, unknown>): string | undefined {
  const validator = plan.validators.find((entry) => entry.id === view.form?.validator)
  return view.form?.fields.find((field) => {
    if (field.input === 'hidden' || !validator?.fields.find((entry) => entry.name === field.field)?.required) return false
    const value = inputs.get(field.field)
    return value === undefined || value === null || value === ''
  })?.field
}

interface Instruction {
  text: string
  params: Array<[string, Primitive]>
  /** Input keys the sending view's form has no label for. */
  unlabelled: string[]
}

function buildInstruction(view: PlanView, route: string, inputs: ReadonlyArray<[string, Primitive]>): Instruction {
  const used = new Set<string>()
  const params: Array<[string, Primitive]> = []
  const unlabelled: string[] = []
  const steps = inputs.map(([name, value], index) => {
    let param = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !used.has(name) ? name : `input${index + 1}`
    while (used.has(param)) param = `${param}_`
    used.add(param)
    params.push([param, value])
    const label = view.form?.fields.find((field) => field.field === name && field.input !== 'hidden')?.label
    if (label === undefined) unlabelled.push(name)
    return label === undefined ? `set the field for ${spoken(name)} to {${param}}` : `set "${spoken(label)}" to {${param}}`
  })
  const action = view.actions.find((entry) => entry.route === route)?.label
  const finish = action === undefined ? 'submit the form' : `use "${spoken(action)}"`
  return { text: steps.length > 0 ? `${steps.join(', ')}, then ${finish}` : finish, params, unlabelled }
}

/**
 * The literals another GET route has where `pattern` has a parameter the start page does not fill:
 * a browser still on `/posts/create` must not satisfy a redirect to `/posts/:id`.
 */
function siblingLiterals(pattern: string, known: ReadonlySet<string>, getPaths: readonly string[]): Map<string, string[]> {
  const segments = pattern.split('/')
  const literals = new Map<string, string[]>()
  segments.forEach((segment, index) => {
    const name = parameterOf(segment)
    if (name === undefined || known.has(name)) return
    const found = getPaths.flatMap((path) => {
      const other = path.split('/')
      if (other.length !== segments.length || parameterOf(other[index]!) !== undefined) return []
      const matches = segments.every((own, position) => position === index || parameterOf(own) !== undefined || parameterOf(other[position]!) !== undefined || own === other[position])
      return matches ? [other[index]!] : []
    })
    if (found.length > 0) literals.set(name, [...new Set(found)].sort(compareStrings))
  })
  return literals
}

function redirectPin(redirect: string, startParameters: ReadonlySet<string>, getPaths: readonly string[]): string {
  if (isParameterless(redirect)) return `await expect(browser).toHaveURL(${quoteString(redirect)})`
  const literals = siblingLiterals(redirect, startParameters, getPaths)
  const not = literals.size > 0 ? `, { ${[...literals].map(([name, values]) => `${name}: [${values.map(quoteString).join(', ')}]`).join(', ')} }` : ''
  return `await expect(browser).toHaveURL(landed(${quoteString(redirect)}, start.values${not}))`
}

interface Registered {
  byName: ReadonlyMap<string, BrowserMapRoute>
  getPaths: readonly string[]
  views: ReadonlyMap<string, BrowserMapView>
  unplaced: ReadonlySet<string>
}

function registered(map: BrowserMap): Registered {
  const routes = map.features.flatMap((feature) => feature.routes)
  const views = [...map.features.flatMap((feature) => feature.views), ...map.unplacedViews]
  return {
    byName: new Map(routes.flatMap((route) => route.name ? [[route.name, route] as const] : [])),
    getPaths: [...new Set([...routes, ...map.unassigned].filter((route) => route.method === 'GET').map((route) => route.path))],
    views: new Map(views.map((entry) => [`${entry.plan}\0${entry.view.id}`, entry])),
    unplaced: new Set(map.unplaced.map((entry) => `${entry.plan}\0${entry.id}`)),
  }
}

function behaviourCase(file: string, plan: Plan, behaviour: PlanAcceptance, app: Registered, options: BehaviourSpecOptions): BehaviourCase {
  const name = `${behaviour.id}: ${unbracketed(behaviour.description)}`
  const skip = (reason: string): BehaviourCase => ({ title: `${name}: ${reason}` })
  if (behaviour.kind !== 'success' && behaviour.kind !== 'validation') return skip(REASONS.kind)
  const route = plan.routes.find((entry) => entry.id === behaviour.route)
  if (!route) return skip(`its route ${behaviour.route} is not in the plan`)
  if (route.method === 'GET') return skip(REASONS.get)
  const view = sendingView(plan.views, route.id)
  if (!view) return skip(REASONS.noView)
  const target = app.byName.get(routeTarget(route).current)
  if (app.unplaced.has(`${file}\0${behaviour.id}`) || !target) return skip(`${route.method} ${route.path} (${route.name}) is not registered yet`)
  const pages = app.views.get(`${file}\0${view.id}`)?.routes ?? []
  const start = pages.find((candidate) => isParameterless(candidate.path)) ?? pages[0]
  if (!start) return skip(`no GET route renders ${view.page} yet`)
  const modes = [target.authentication, start.authentication]
  if (modes.includes('required') && !options.signIn) return skip(REASONS.signIn)
  // An action may refuse a guest in its body (`this.auth.userOrFail()`), which the graph does not read: only a guest-only route runs signed out.
  const signedIn = modes.includes('required') || (options.signIn && !modes.includes('guest-only'))

  const decoded = (behaviour.input ?? []).map(({ name: key, json }): [string, unknown] => [key, decode(json)])
  if (behaviour.kind === 'validation' && view.form?.submitsTo === route.id && emptyRequiredField(plan, view, new Map(decoded)) !== undefined) return skip(REASONS.required)
  const inputs = decoded.filter((entry): entry is [string, Primitive] => isPrimitive(entry[1]))
  if (inputs.length !== decoded.length) return skip(REASONS.input)

  const startParameters = new Set(start.path.split('/').flatMap((segment) => parameterOf(segment) ?? []))
  const landing = behaviour.expect.inertia === undefined ? undefined : plan.views.find((entry) => entry.id === behaviour.expect.inertia)
  const errorLabels = (behaviour.expect.errors ?? []).flatMap((key) => view.form?.fields.find((field) => field.field === key && field.input !== 'hidden')?.label ?? [])
  const screenPins = [
    ...(landing?.form?.fields ?? []).filter((field) => field.input !== 'hidden').map((field) => visible(labelLocator(field.label))),
    ...(landing?.actions ?? []).map((action) => visible(actionLocator(action.label))),
    ...errorLabels.map((label) => `await expect(${labelLocator(label)}.first()).toHaveAttribute('aria-invalid', 'true')`),
  ]
  const pins = [...(behaviour.expect.redirect === undefined ? [] : [redirectPin(behaviour.expect.redirect, startParameters, app.getPaths)]), ...screenPins]
  if (pins.length === 0) return skip(REASONS.outcome)

  const instruction = buildInstruction(view, route.id, inputs)
  const needsGiven = startParameters.size > 0
    ? `its start page ${start.path} takes a path parameter`
    : behaviour.given.length > 0 ? 'the plan gives it a starting state' : undefined
  const params = instruction.params.length > 0 ? `, { params: { ${instruction.params.map(([param, value]) => `${param}: ${literal(value)}`).join(', ')} } }` : ''
  const body = [
    `const start = await begin(${quoteString(behaviour.id)}, ${needsGiven === undefined ? 'undefined' : quoteString(needsGiven)}, { app, browser })`,
    `await app.open(start.path(${quoteString(start.path)}))`,
    'await expectDefaultLocale(browser)',
    "const off = await browser.onDialog('accept')",
    `await agent.act(${quoteString(instruction.text)}${params})`,
    'await off()',
    ...pins,
  ]
  const digest = createHash('sha256').update(JSON.stringify([start.path, signedIn, body])).digest('hex').slice(0, 6)
  return { title: `${behaviour.id} (${digest}): ${unbracketed(behaviour.description)}`, body, signedIn, screen: screenPins.length > 0, unlabelled: instruction.unlabelled }
}

function renderCase(entry: BehaviourCase): string {
  if (!entry.body) return `test.skip(${quoteString(entry.title)}, async () => {})`
  const fixtures = ['app', 'agent', ...(entry.screen ? ['screen'] : []), 'browser'].join(', ')
  const session = entry.signedIn ? `{ session: ${quoteString(BEHAVIOUR_SESSION)} }, ` : ''
  return [`test(${quoteString(entry.title)}, ${session}async ({ ${fixtures} }) => {`, ...entry.body.map((line) => `  ${line}`), '})'].join('\n')
}

const PRELUDE = `type InitialPage = { props?: { _i18n?: { locale?: unknown; fallbackLocale?: unknown } } } | null

interface Start {
  values: Record<string, string>
  path(pattern: string): string
}

/** The behaviour's entry in given.ts: its data, and the values of the start page's path parameters. */
async function begin(id: string, needs: string | undefined, fixtures: GivenFixtures): Promise<Start> {
  const entry = given[id]
  test.skip(!entry && needs !== undefined, \`\${needs}, and ${BEHAVIOURS_GIVEN_FILE} has no entry for it\`)
  const values = (await entry?.(fixtures)) ?? {}
  return {
    values,
    path: (pattern) => pattern.split('/').map((segment) => {
      const name = /^:([A-Za-z_][A-Za-z0-9_]*)/u.exec(segment)?.[1]
      if (name === undefined) return segment
      const value = values[name]
      if (value === undefined) throw new Error(\`\${id}: its entry in ${BEHAVIOURS_GIVEN_FILE} returned no value for :\${name} of \${pattern}\`)
      return encodeURIComponent(value)
    }).join('/'),
  }
}

/** \`pattern\` as the URL the browser landed on: a parameter \`known\` holds is its value, any other is one segment that is none of \`not\`. */
function landed(pattern: string, known: Record<string, string>, not: Record<string, readonly string[]> = {}): RegExp {
  const escape = (text: string): string => text.replace(/[.*+?^\${}()|[\\]\\\\]/gu, '\\\\$&')
  const segments = pattern.split('/').map((segment) => {
    const name = /^:([A-Za-z_][A-Za-z0-9_]*)/u.exec(segment)?.[1]
    if (name === undefined) return escape(segment)
    const value = known[name]
    if (value !== undefined) return escape(encodeURIComponent(value))
    const excluded = (not[name] ?? []).map(escape)
    return \`\${excluded.length > 0 ? \`(?!(?:\${excluded.join('|')})(?:[/?#]|$))\` : ''}[^/?#]+\`
  })
  return new RegExp(\`^(?:[a-z][a-z0-9+.-]*://[^/]+)?\${segments.join('/')}(?:[?#].*)?$\`, 'u')
}

/** The page rendered in the app's default locale, which the plan's labels are in (RFC 0036 §5). Read after a full load only. */
async function expectDefaultLocale(browser: GivenFixtures['browser']): Promise<void> {
  const i18n = await browser.evaluate(() => {
    let initial = (window as Window & { __INERTIA_PAGE__?: InitialPage }).__INERTIA_PAGE__
    if (!initial) {
      try {
        initial = JSON.parse(document.querySelector('script[data-page="app"][type="application/json"]')?.textContent ?? 'null') as InitialPage
      } catch {
        initial = null
      }
    }
    const shared = initial?.props?._i18n
    return shared ? { locale: String(shared.locale), fallbackLocale: String(shared.fallbackLocale) } : null
  })
  if (i18n && i18n.locale !== i18n.fallbackLocale) {
    throw new Error(\`the page rendered in \${i18n.locale}, not the app's default \${i18n.fallbackLocale}, which the plan's labels are in: set the locale in ${BEHAVIOURS_CONFIG}, then look for a ${LOCALE_COOKIE} cookie in the saved session\`)
  }
}`

function render(cases: readonly BehaviourCase[]): string {
  const live = cases.some((entry) => entry.body)
  const imports = live
    ? ["import { test } from '@e2e-dev/web'", "import { expect } from 'e2e'", "import { given, type GivenFixtures } from '../given'"]
    : ["import { test } from '@e2e-dev/web'"]
  return `${GENERATED_HEADER}${imports.join('\n')}\n\n${live ? `${PRELUDE}\n\n` : ''}${cases.map(renderCase).join('\n\n')}\n`
}

export interface BehaviourSpecs {
  files: ScaffoldFileEntry[]
  /** Input keys a written test sets that the sending view's form does not label, as `plan: id: key`. */
  unlabelled: string[]
}

/**
 * One spec per approved plan with a behaviour, its tests in id order. `sharedSlugs` is
 * `PlanDiscovery.sharedSlugs` with app-relative files: a plan whose slug another plan shares refuses,
 * since its spec is named by that slug.
 */
export function buildBehaviourSpecs(
  map: BrowserMap,
  plans: readonly ApprovedPlanInput[],
  options: BehaviourSpecOptions,
  sharedSlugs: ReadonlyMap<string, readonly string[]>,
): BehaviourSpecs {
  const app = registered(map)
  const unlabelled: string[] = []
  const files = [...plans].sort((a, b) => compareStrings(a.file, b.file)).flatMap(({ file, plan }): ScaffoldFileEntry[] => {
    const behaviours = plan.tasks.flatMap((task) => task.acceptance).sort((a, b) => compareStrings(a.id, b.id))
    if (behaviours.length === 0) return []
    const slug = planSlug(file)
    const shared = sharedSlugs.get(slug)
    if (shared) throw new CliError(`${shared.join(', ')} share the slug ${slug}, so ${file}'s behaviour spec would be named for more than one plan; rename all but one (guren check --plan reports this too).`)
    const cases = behaviours.map((behaviour) => behaviourCase(file, plan, behaviour, app, options))
    cases.forEach((entry, index) => unlabelled.push(...(entry.unlabelled ?? []).map((key) => `${file}: ${behaviours[index]!.id}: ${key}`)))
    return [{ path: `${GENERATED_BEHAVIOURS_DIR}/${slug}.e2e.ts`, contents: render(cases) }]
  })
  return { files, unlabelled }
}
