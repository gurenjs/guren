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
import { BOUND_RULE, FORMAT_RULES } from './plan/field-status'
import type { Plan, PlanAcceptance, PlanView } from './plan/schema'
import { quoteString } from './schema-columns'
import { compareStrings } from './spec-artifact'
import { escapeTemplateLiteral, PATH_PARAM_PATTERN, type ScaffoldFileEntry } from './utils'

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
  query: 'its route is a QUERY, which no form or link sends',
  noView: 'no view of the plan sends its route, so nothing says which page to start on',
  signIn: 'needs a signed-in user, and the app has no password sign-in for the setup test',
  outcome: 'no outcome a browser can check after the step: every expectation is a status or a database row, an errors key has no labelled field, or what it lands on already showed before the step',
  input: 'an input is not a string, a number or a boolean, and nothing says how a control takes it',
  control: "its input is one the form's own control may stop or change before a request is sent (an empty, missing, out-of-range or malformed value), so no error would be rendered; TestApp pins it",
} as const

interface PathParam {
  name: string
  /** Optional (`?`) or a wildcard (`*`): it stands for no segment or several. */
  open: boolean
}

/** A route path as literals and parameters, by the rule every route generator lexes with. */
function lexPath(path: string): Array<string | PathParam> {
  const parts: Array<string | PathParam> = []
  let at = 0
  for (const match of path.matchAll(PATH_PARAM_PATTERN)) {
    const literal = `${path.slice(at, match.index)}${match[1]!}`
    if (literal) parts.push(literal)
    const label = match[2]!
    parts.push({ name: label.replace(/\*$/u, ''), open: label.endsWith('*') || match[0].endsWith('?') })
    at = match.index + match[0].length
  }
  if (at < path.length) parts.push(path.slice(at))
  return parts
}

/** Whether a spec can write the path out: every parameter is one segment, and no bare `*` is left. */
function isClosed(parts: ReadonlyArray<string | PathParam>): boolean {
  return parts.every((part) => typeof part === 'string' ? !part.includes('*') : !part.open)
}

/** `/`-separated segments with each parameter as `undefined`, so a constraint holding a `/` splits nothing. */
function segmentsOf(path: string): Array<string | undefined> {
  return path.replace(PATH_PARAM_PATTERN, '$1\0').split('/').map((segment) => segment.includes('\0') ? undefined : segment)
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

/** The view that sends `route`: one whose form submits to it, else one with an action for it. Its form counts only in the first case. */
function sendingView(views: readonly PlanView[], route: string): PlanView | undefined {
  const live = views.filter((view) => view.change.kind !== 'drop').sort((a, b) => compareStrings(a.id, b.id))
  return live.find((view) => view.form?.submitsTo === route) ?? live.find((view) => view.actions.some((action) => action.route === route))
}

type ValidatorField = Plan['validators'][number]['fields'][number]
type ViewForm = NonNullable<PlanView['form']>

const NUMERIC = new Set<ValidatorField['type']>(['integer', 'number', 'decimal'])
const TEXTUAL = new Set<ValidatorField['type']>(['string', 'text'])

/** Whether `value` breaks a constraint the field's control renders (`min`, `max`, `step`, a length or an input type), read from the plan's rules. */
function breaksRenderedRule(field: ValidatorField, value: Primitive): boolean {
  const bounds = field.rules.flatMap((rule) => {
    const parsed = BOUND_RULE.exec(rule.trim())
    return parsed ? [{ side: parsed[1]!.toLowerCase(), bound: Number(parsed[2]) }] : []
  })
  const outside = (size: number): boolean => bounds.some(({ side, bound }) => side === 'min' ? size < bound : size > bound)
  if (NUMERIC.has(field.type)) return typeof value !== 'number' || (field.type === 'integer' && !Number.isInteger(value)) || outside(value)
  if (field.type === 'date' || field.type === 'datetime') return typeof value !== 'string' || Number.isNaN(Date.parse(value))
  if (!TEXTUAL.has(field.type) || typeof value !== 'string') return false
  const formats = new Set(field.rules.map((rule) => FORMAT_RULES[rule.trim().toLowerCase()]))
  return outside(value.length) || (formats.has('email') && !/^[^\s@]+@[^\s@]+$/u.test(value)) || (formats.has('uri') && !URL.canParse(value))
}

/**
 * Whether the browser may keep a `validation` input from reaching the server: a labelled field left
 * empty, a required one left out, or a value its control refuses. Judged from the plan's validator,
 * towards skipping: a test whose submit never happens could not pass.
 */
function controlMayStop(plan: Plan, form: ViewForm, inputs: ReadonlyMap<string, unknown>): boolean {
  const validator = plan.validators.find((entry) => entry.id === form.validator)
  return form.fields.some((field) => {
    if (field.input === 'hidden') return false
    const rule = validator?.fields.find((entry) => entry.name === field.field)
    if (!inputs.has(field.field)) return rule?.required === true
    const value = inputs.get(field.field)
    if (value === '' || value === null) return true
    return rule !== undefined && isPrimitive(value) && breaksRenderedRule(rule, value)
  })
}

interface Instruction {
  text: string
  params: Array<[string, Primitive]>
  /** Input keys the sending view's form has no label for. */
  unlabelled: string[]
}

function buildInstruction(view: PlanView, form: ViewForm | undefined, route: string, inputs: ReadonlyArray<[string, Primitive]>): Instruction {
  const used = new Set<string>()
  const params: Array<[string, Primitive]> = []
  const unlabelled: string[] = []
  const steps = inputs.map(([name, value], index) => {
    let param = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !used.has(name) ? name : `input${index + 1}`
    while (used.has(param)) param = `${param}_`
    used.add(param)
    params.push([param, value])
    const label = form?.fields.find((field) => field.field === name && field.input !== 'hidden')?.label
    if (label === undefined) unlabelled.push(name)
    return label === undefined ? `set the field for ${spoken(name)} to {${param}}` : `set "${spoken(label)}" to {${param}}`
  })
  const action = view.actions.find((entry) => entry.route === route)?.label
  const finish = action === undefined ? 'submit the form' : `use "${spoken(action)}"`
  return { text: steps.length > 0 ? `${steps.join(', ')}, then ${finish}` : finish, params, unlabelled }
}

/**
 * The redirect as a URL assertion, or none when it cannot be one: an optional or wildcard segment, or
 * the start page itself, which holds before the step. A parameter the start page fills is its value;
 * any other is one segment, except a literal another GET route has there (`/posts/create` for `/posts/:id`).
 */
function redirectPin(redirect: string, startPath: string, startParameters: ReadonlySet<string>, getPaths: readonly string[]): string | undefined {
  const parts = lexPath(redirect)
  if (redirect === startPath || !isClosed(parts)) return undefined
  if (parts.every((part) => typeof part === 'string')) return `await expect(browser).toHaveURL(${quoteString(redirect)})`
  const segments = segmentsOf(redirect)
  const positions = segments.flatMap((segment, index) => segment === undefined ? [index] : [])
  const params = parts.filter((part): part is PathParam => typeof part !== 'string')
  const rendered = parts.map((part) => {
    if (typeof part === 'string') return quoteString(part)
    if (startParameters.has(part.name)) return `{ known: ${quoteString(part.name)} }`
    const index = positions[params.indexOf(part)]
    const literals = index === undefined ? [] : getPaths.flatMap((path) => {
      const other = segmentsOf(path)
      const sibling = other.length === segments.length && other[index] !== undefined
        && segments.every((own, position) => position === index || own === undefined || other[position] === undefined || own === other[position])
      return sibling ? [other[index]!] : []
    })
    return `{ not: [${[...new Set(literals)].sort(compareStrings).map(quoteString).join(', ')}] }`
  })
  return `await expect(browser).toHaveURL(landed([${rendered.join(', ')}], start))`
}

interface Registered {
  byName: ReadonlyMap<string, BrowserMapRoute>
  /** Why the map placed a registered route in no feature, by route name. */
  unassigned: ReadonlyMap<string, string>
  getPaths: readonly string[]
  views: ReadonlyMap<string, BrowserMapView>
  unplaced: ReadonlySet<string>
}

function registered(map: BrowserMap): Registered {
  const routes = map.features.flatMap((feature) => feature.routes)
  const views = [...map.features.flatMap((feature) => feature.views), ...map.unplacedViews]
  return {
    byName: new Map(routes.flatMap((route) => route.name ? [[route.name, route] as const] : [])),
    unassigned: new Map(map.unassigned.flatMap((route) => route.name ? [[route.name, route.reason] as const] : [])),
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
  if (route.method === 'QUERY') return skip(REASONS.query)
  const view = sendingView(plan.views, route.id)
  if (!view) return skip(REASONS.noView)
  const described = `${route.method} ${route.path} (${route.name})`
  const current = routeTarget(route).current
  const target = app.byName.get(current)
  if (!target || app.unplaced.has(`${file}\0${behaviour.id}`)) {
    const why = app.unassigned.get(current)
    return skip(why === undefined ? `${described} is not registered yet` : `the map places ${described} in no feature: ${why}`)
  }
  const pages = app.views.get(`${file}\0${view.id}`)?.routes ?? []
  const start = pages.find((candidate) => isParameterless(candidate.path)) ?? pages[0]
  if (!start) return skip(`no GET route renders ${view.page} yet`)
  const startParts = lexPath(start.path)
  if (!isClosed(startParts)) return skip(`its start page ${start.path} has an optional or wildcard segment, which given.ts cannot fill`)
  const modes = [target.authentication, start.authentication]
  if (modes.includes('required') && !options.signIn) return skip(REASONS.signIn)
  // An action may refuse a guest in its body (`this.auth.userOrFail()`), which the graph does not read: only a guest-only route runs signed out.
  const signedIn = modes.includes('required') || (options.signIn && !modes.includes('guest-only'))

  const form = view.form?.submitsTo === route.id ? view.form : undefined
  const decoded = (behaviour.input ?? []).map(({ name: key, json }): [string, unknown] => [key, decode(json)])
  if (behaviour.kind === 'validation' && form && controlMayStop(plan, form, new Map(decoded))) return skip(REASONS.control)
  const inputs = decoded.filter((entry): entry is [string, Primitive] => isPrimitive(entry[1]))
  if (inputs.length !== decoded.length) return skip(REASONS.input)

  const startParameters = new Set(startParts.flatMap((part) => typeof part === 'string' ? [] : [part.name]))
  // The sending view's own labels and actions showed before the step, so they pin nothing.
  const landing = behaviour.expect.inertia === undefined || behaviour.expect.inertia === view.id ? undefined : plan.views.find((entry) => entry.id === behaviour.expect.inertia)
  const errorLabels = (behaviour.expect.errors ?? []).flatMap((key) => form?.fields.find((field) => field.field === key && field.input !== 'hidden')?.label ?? [])
  const screenPins = [
    ...(landing?.form?.fields ?? []).filter((field) => field.input !== 'hidden').map((field) => visible(labelLocator(field.label))),
    ...(landing?.actions ?? []).map((action) => visible(actionLocator(action.label))),
    ...errorLabels.map((label) => `await expect(${labelLocator(label)}.first()).toHaveAttribute('aria-invalid', 'true')`),
  ]
  const urlPin = behaviour.expect.redirect === undefined ? undefined : redirectPin(behaviour.expect.redirect, start.path, startParameters, app.getPaths)
  const pins = [...(urlPin === undefined ? [] : [urlPin]), ...screenPins]
  if (pins.length === 0) return skip(REASONS.outcome)

  const instruction = buildInstruction(view, form, route.id, inputs)
  const needsGiven = startParameters.size > 0
    ? `its start page ${start.path} takes a path parameter`
    : behaviour.given.length > 0 ? 'the plan gives it a starting state' : undefined
  const params = instruction.params.length > 0 ? `, { params: { ${instruction.params.map(([param, value]) => `${param}: ${literal(value)}`).join(', ')} } }` : ''
  const opened = startParameters.size === 0
    ? quoteString(start.path)
    : `\`${startParts.map((part) => typeof part === 'string' ? escapeTemplateLiteral(part) : `\${start.value(${quoteString(part.name)})}`).join('')}\``
  const steps = [
    `await app.open(${opened})`,
    'await expectDefaultLocale(browser)',
    "const off = await browser.onDialog('accept')",
    `await agent.act(${quoteString(instruction.text)}${params})`,
    'await off()',
    ...pins,
  ]
  const begun = `await begin(${quoteString(behaviour.id)}, ${needsGiven === undefined ? 'undefined' : quoteString(needsGiven)}, { app, browser })`
  const body = [steps.some((line) => /\bstart[.)]/u.test(line)) ? `const start = ${begun}` : begun, ...steps]
  const digest = createHash('sha256').update(JSON.stringify([signedIn, body])).digest('hex').slice(0, 6)
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
  /** A path parameter's value from given.ts, encoded for a URL. */
  value(name: string): string
}

/** The behaviour's entry in given.ts: its data, and the values of the start page's path parameters. */
async function begin(id: string, needs: string | undefined, fixtures: GivenFixtures): Promise<Start> {
  const entry = given[id]
  test.skip(!entry && needs !== undefined, \`\${needs}, and ${BEHAVIOURS_GIVEN_FILE} has no entry for it\`)
  const values = (await entry?.(fixtures)) ?? {}
  return {
    value: (name) => {
      const value = values[name]
      if (value === undefined) throw new Error(\`\${id}: its entry in ${BEHAVIOURS_GIVEN_FILE} returned no value for :\${name}\`)
      return encodeURIComponent(value)
    },
  }
}

type UrlPart = string | { known: string } | { not: readonly string[] }

/** The URL the browser landed on: \`known\` is a parameter given.ts filled, \`not\` one segment that is none of the listed. */
function landed(parts: readonly UrlPart[], start: Start): RegExp {
  const escape = (text: string): string => text.replace(/[.*+?^\${}()|[\\]\\\\]/gu, '\\\\$&')
  const source = parts.map((part) => {
    if (typeof part === 'string') return escape(part)
    if ('known' in part) return escape(start.value(part.known))
    const excluded = part.not.map(escape)
    return \`\${excluded.length > 0 ? \`(?!(?:\${excluded.join('|')})(?:[/?#]|$))\` : ''}[^/?#]+\`
  }).join('')
  return new RegExp(\`^(?:[a-z][a-z0-9+.-]*://[^/]+)?\${source}(?:[?#].*)?$\`, 'u')
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
