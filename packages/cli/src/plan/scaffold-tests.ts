/**
 * The test skeletons of a plan's `tests` step (RFC 0030 §5, Part 3 item 7a), pure like `scaffold.ts`:
 * one `TestApp` test per acceptance behaviour, titled `[<id>] <description>`, with the request its
 * route names and the `expect` the plan states. What the plan says only in prose (the `given` setup,
 * a signed-in actor, a path parameter's value) is a `given()` call that throws, and an expectation the
 * skeleton cannot write is an `unwritten()` call that throws, so every case fails until it is written
 * and none is skipped. Requests are spelled so `test-requests.ts` reads each one back to its route.
 */

import { collectionSlug } from '../inflect'
import { quoteString } from '../schema-columns'
import { escapeTemplateLiteral, isBindingName, PATH_PARAM_PATTERN, quoteObjectKey } from '../utils'
import { bracketedTokens, isAcceptanceId, SKELETON_BOOT_FAILED } from './acceptance-status'
import { importSpecifier } from './scaffold-controller'
import type { PlanScaffoldFile } from './scaffold'
import type { PlanScaffoldUnwritten } from './scaffold-http'
import type { PlanAcceptance, PlanColumn, PlanDraft, PlanModel, PlanRoute } from './schema'
import type { PlanDerivedStep, PlanDerivedTask } from './tasks'

export interface PlanTestsApp {
  /** The app-relative entry whose default export is the application: `src/app.ts` or `app.ts`. */
  entry: string
  /** The root's model classes, by name, with the app-relative file declaring each. */
  modelFiles: Readonly<Record<string, string>>
}

export interface PlanTestsOutput {
  file: PlanScaffoldFile
  /** Expectations written as an `unwritten()` call, which the agent writes by hand. */
  unwritten: PlanScaffoldUnwritten[]
  /** Behaviours on a route the application has, with no `given()` or `unwritten()` call, whose test may already pass, which `tests:fail` refuses. */
  mayPassNow: string[]
  /** Why nothing may be written. Non-empty means the output is not to be used. */
  refusals: string[]
}

// Must match the message `withCsrf()` throws in packages/testing/src/test-app.ts for the default path.
export const PLAN_TESTS_CSRF_ABSENT = 'withCsrf(): GET / did not set an XSRF-TOKEN cookie.'

/** Names the file declares itself, which a parameter or a model import must not take. */
const FILE_NAMES: ReadonlySet<string> = new Set(['beforeAll', 'describe', 'expect', 'test', 'TestApp', 'booted', 'ready', 'client', 'given', 'unwritten', 'actor', 'response', 'body'])

/** A file name from a plan id or slug: what a path segment may hold on every platform. */
function fileSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]/gu, '-')
}

function taskFileName(task: PlanDerivedTask): string {
  switch (task.title.kind) {
    case 'foundation':
      return 'foundation'
    case 'entity':
      return collectionSlug(task.title.name)
    case 'story':
      return fileSegment(task.title.intent)
    case 'cross':
      return task.title.models.map(fileSegment).join('-')
  }
}

/** One file per plan and task, so a second plan on the same entity writes a file of its own. */
export function planTestsFilePath(slug: string, task: PlanDerivedTask): string {
  return `tests/plans/${fileSegment(slug)}/${taskFileName(task)}.test.ts`
}

/**
 * Prose written into the file loses its brackets: a `[AC-…]` token in it would read as a behaviour
 * this file carries, which `plan:verify` selects files by and the drift re-check counts.
 */
function prose(text: string): string {
  return text.replace(/\[/gu, '(').replace(/\]/gu, ')').replace(/\s+/gu, ' ').trim()
}

/** A JSON value as a TypeScript expression. */
function literal(value: unknown): string {
  if (typeof value === 'string') return quoteString(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  // A literal `__proto__` key sets the prototype; a computed one is an own property, as JSON.parse makes it.
  return `{ ${entries.map(([key, entry]) => `${key === '__proto__' ? "['__proto__']" : quoteObjectKey(key)}: ${literal(entry)}`).join(', ')} }`
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

function queryString(input: PlanAcceptance['input']): string {
  if (!input?.length) return ''
  const pairs = input.map(({ name, json }) => {
    const value = parseJson(json)
    return `${encodeURIComponent(name)}=${encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value))}`
  })
  return `?${pairs.join('&')}`
}

// A bare `*` segment takes any value, which the test has to choose like a parameter's.
const WILDCARD_SEGMENT = /(?<=^|\/)\*(?=\/|$)/u

/** A route path as code, each parameter a whole-segment interpolation, which is what `test-requests.ts` reads as filling it. */
class RequestPath {
  readonly params: Array<{ label: string; variable: string }> = []

  constructor(private readonly taken: ReadonlySet<string>) {}

  /** The route's own path: every parameter gets a variable. */
  request(path: string, suffix: string): string {
    return this.render(path, suffix, (label) => this.variable(label))!
  }

  /** A path that may use only the route's parameters; `null` when it names another, whose value only the implementation knows. */
  redirect(path: string): string | null {
    return this.render(path, '', (label) => this.params.find((param) => param.label === label)?.variable ?? null)
  }

  private variable(label: string): string {
    const known = this.params.find((param) => param.label === label)
    if (known) return known.variable
    const variable = isBindingName(label) && !this.taken.has(label) ? label : `param${this.params.length + 1}`
    this.params.push({ label, variable })
    return variable
  }

  private render(path: string, suffix: string, fill: (label: string) => string | null): string | null {
    const pieces: string[] = []
    let last = 0
    for (const { 0: token, 1: boundary, 2: name, index } of path.matchAll(PATH_PARAM_PATTERN)) {
      const variable = fill(name!.replace(/\*$/u, ''))
      if (variable === null) return null
      pieces.push(escapeTemplateLiteral(path.slice(last, index) + boundary), `\${${variable}}`)
      last = index + token.length
    }
    const [head, ...afterWildcards] = path.slice(last).split(WILDCARD_SEGMENT)
    pieces.push(escapeTemplateLiteral(head!))
    for (const rest of afterWildcards) {
      const variable = fill('wildcard')
      if (variable === null) return null
      pieces.push(`\${${variable}}`, escapeTemplateLiteral(rest))
    }
    if (pieces.length === 1) return quoteString(path + suffix)
    return `\`${pieces.join('')}${escapeTemplateLiteral(suffix)}\``
  }
}

/** Whether a has/missing value is a literal the model's record types the column as. */
function comparesWith(column: PlanColumn, value: unknown): boolean {
  if (value === null) return column.nullable
  switch (column.type) {
    case 'string':
    case 'text':
    case 'uuid':
      return typeof value === 'string'
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    default:
      // A decimal reads back as a string, a date as a Date and JSON as anything: no literal is typed as all of them.
      return false
  }
}

class TestsEmitter {
  readonly unwritten: PlanScaffoldUnwritten[] = []
  readonly mayPassNow: string[] = []
  readonly refusals: string[] = []
  readonly models = new Map<string, string>()
  private readonly taken: ReadonlySet<string>
  private usesGiven = false
  private usesUnwritten = false
  private usesExpect = false
  /** Whether the behaviour being written has a `given()` or `unwritten()` call, either of which fails its test. */
  private placeholder = false

  constructor(
    private readonly plan: PlanDraft,
    private readonly path: string,
    private readonly app: PlanTestsApp,
  ) {
    this.taken = new Set([...FILE_NAMES, ...plan.models.map((model) => model.name)])
  }

  private leave(behaviour: PlanAcceptance, detail: string, reason: string, lines: string[]): void {
    this.unwritten.push({ element: behaviour.id, detail, reason })
    this.usesUnwritten = true
    this.placeholder = true
    lines.push(`    unwritten(${quoteString(prose(`${detail}: ${reason}`))})`)
  }

  private given(prompt: string, binding?: { name: string; type: string }): string {
    this.usesGiven = true
    this.placeholder = true
    const call = `given${binding ? `<${binding.type}>` : ''}(${quoteString(prose(prompt))})`
    return binding ? `    const ${binding.name} = ${call}` : `    ${call}`
  }

  /** Only `auth` / `auth:*` middleware, a policy, or a `forbidden` behaviour implies a signed-in actor; `unauthenticated` never does. */
  private needsUser(behaviour: PlanAcceptance, route: PlanRoute): boolean {
    if (behaviour.kind === 'unauthenticated') return false
    const action = this.plan.controllers.flatMap((controller) => controller.actions).find((candidate) => candidate.id === route.action)
    const middleware = [...route.middleware, ...(action?.authorization.middleware ?? [])]
    return behaviour.kind === 'forbidden' || action?.authorization.policy !== undefined || middleware.some((name) => name === 'auth' || name.startsWith('auth:'))
  }

  /** The model class a database row is read through, imported from the root; a reason when the row cannot be. */
  private modelFor(table: string): { model: PlanModel; reason?: undefined } | { model?: undefined; reason: string } {
    const model = this.plan.models.find((candidate) => candidate.table === table)
    if (!model) return { reason: `no model of the plan declares the table ${table}` }
    if (model.module) return { reason: `${model.name} is in the module ${model.module}, whose models a root test does not import` }
    const file = this.app.modelFiles[model.name]
    if (file === undefined) return { reason: `the application root declares no ${model.name} model yet` }
    if (FILE_NAMES.has(model.name)) return { reason: `${model.name} would shadow a name the test file declares` }
    this.models.set(model.name, file)
    return { model }
  }

  /** Whether a `has` row was written, which a route that does not exist yet cannot satisfy. */
  private databaseRow(behaviour: PlanAcceptance, row: NonNullable<PlanAcceptance['expect']['database']>[number], lines: string[]): boolean {
    let failsUnrouted = false
    for (const [side, values] of [['has', row.has], ['missing', row.missing]] as const) {
      if (!values?.length) continue
      const detail = `database ${row.table} ${side} ${values.map((value) => `${value.name} = ${value.json}`).join(', ')}`
      const found = this.modelFor(row.table)
      if (!found.model) {
        this.leave(behaviour, detail, found.reason, lines)
        continue
      }
      const model = found.model
      const conditions: string[] = []
      let reason: string | undefined
      for (const value of values) {
        const column = model.columns.find((candidate) => candidate.name === value.name || candidate.columnName === value.name)
        const parsed = parseJson(value.json)
        if (!column) reason ??= `${value.name} is no column the plan declares on ${model.name}`
        else if (!comparesWith(column, parsed)) reason ??= `${value.json} is no literal a ${column.type}${column.nullable ? ' (nullable)' : ''} column compares with`
        else conditions.push(`${quoteObjectKey(column.name)}: ${literal(parsed)}`)
      }
      if (reason !== undefined) {
        this.leave(behaviour, detail, reason, lines)
        continue
      }
      this.usesExpect = true
      lines.push(`    expect(await ${model.name}.where({ ${conditions.join(', ')} }).first())${side === 'has' ? '.not.toBeNull()' : '.toBeNull()'}`)
      if (side === 'has') failsUnrouted = true
    }
    return failsUnrouted
  }

  test(behaviour: PlanAcceptance): string {
    const title = quoteString(`[${behaviour.id}] ${prose(behaviour.description)}`)
    const lines: string[] = []
    this.placeholder = false
    const route = this.plan.routes.find((candidate) => candidate.id === behaviour.route)
    if (!route) {
      // §2 refuses a behaviour naming no route before approval; this guards a plan no check has read.
      this.refusals.push(`${behaviour.id} names the route ${behaviour.route}, which the plan does not declare.`)
      return ''
    }

    for (const setup of behaviour.given) lines.push(this.given(setup))
    const user = this.needsUser(behaviour, route)
    if (user) lines.push(this.given(`the actor: ${behaviour.actor}`, { name: 'actor', type: 'object' }))
    const path = new RequestPath(this.taken)
    const safe = route.method === 'GET'
    const url = path.request(route.path, safe ? queryString(behaviour.input) : '')
    for (const param of path.params) lines.push(this.given(`the :${param.label} parameter`, { name: param.variable, type: 'number | string' }))

    const body = !safe && behaviour.input?.length ? `, ${literal(Object.fromEntries(behaviour.input.map(({ name, json }) => [name, parseJson(json)])))}` : ''
    const view = behaviour.expect.inertia === undefined ? undefined : this.plan.views.find((candidate) => candidate.id === behaviour.expect.inertia)
    // Accept: application/json takes the page as JSON through the same renderer, without the X-Inertia version check's 409.
    const receiver = `(await client(${user ? 'actor' : ''}))${view ? '.json()' : ''}`
    const chain: string[] = []
    const after: string[] = []
    let failsUnrouted = false
    const { status, redirect, errors } = behaviour.expect
    if (status !== undefined) {
      chain.push(`.assertStatus(${status})`)
      failsUnrouted = status !== 404
    }
    if (redirect !== undefined) {
      const target = path.redirect(redirect)
      if (target === null) this.leave(behaviour, `redirect ${redirect}`, 'it names a parameter the route does not, whose value only the implementation knows', after)
      else {
        chain.push(`.assertRedirect(${target})`)
        failsUnrouted = true
      }
    }
    if (behaviour.expect.inertia !== undefined) {
      if (view) {
        chain.push(`.assertInertia(${quoteString(view.page)})`)
        failsUnrouted = true
      } else this.leave(behaviour, `inertia ${behaviour.expect.inertia}`, 'the plan declares no such view', after)
    }
    const request = `${receiver}.${route.method.toLowerCase()}(${url}${body})${chain.join('')}`
    if (errors?.length) {
      this.usesExpect = true
      lines.push(`    const response = await ${request}`)
      lines.push('    const body = await response.json<{ errors?: Record<string, unknown> }>()')
      lines.push(`    expect(Object.keys(body.errors ?? {})).toEqual(expect.arrayContaining([${errors.map((field) => quoteString(field)).join(', ')}]))`)
      failsUnrouted = true
    } else {
      lines.push(`    await ${request}`)
    }
    lines.push(...after)
    for (const row of behaviour.expect.database ?? []) {
      if (this.databaseRow(behaviour, row, lines)) failsUnrouted = true
    }
    if (status === 404) {
      this.leave(behaviour, 'status 404', 'a route that does not exist yet answers 404 as well, so assert what tells the two apart', lines)
    } else if (!failsUnrouted) {
      this.leave(behaviour, 'expect', 'nothing written here fails against a route that does not exist yet, so assert what the behaviour changes', lines)
    }
    // A route the application already has (renamed ones usually keep their path) may answer as the plan expects today.
    if (route.change.kind !== 'add' && route.change.kind !== 'drop' && !this.placeholder) this.mayPassNow.push(behaviour.id)
    return `  test(${title}, async () => {\n${lines.join('\n')}\n  })`
  }

  source(planFile: string, stepId: string, describeName: string, tests: readonly string[]): string {
    const testImports = ['beforeAll', 'describe', ...(this.usesExpect ? ['expect'] : []), 'test']
    const imports = [
      `import { ${testImports.join(', ')} } from 'bun:test'`,
      "import { TestApp } from '@guren/testing'",
      ...[...this.models].sort(([left], [right]) => (left < right ? -1 : 1)).map(([name, file]) => `import { ${name} } from '${importSpecifier(this.path, file)}'`),
    ]
    const helpers = [
      [
        `// Written by plan:scaffold from ${prose(planFile)} (${stepId}). Keep each title's id and the request`,
        '// it makes: plan:verify finds a behaviour by its id, and each test fails until its implementation exists.',
        '// Rows are yours to set up and clean up: a row another test left can pass or fail a database expectation.',
        '// The beforeAll below boots the application before any hook or setup of yours runs; open a hook of your',
        '// own with `await ready()`, so a boot that fails is what each test reports rather than a database error.',
        'let booted: Promise<TestApp> | undefined',
      ].join('\n'),
      [
        '/** The booted application; once a boot fails, every call rejects with that failure. */',
        'function ready(): Promise<TestApp> {',
        `  booted ??= import('${importSpecifier(this.path, this.app.entry)}')`,
        '    .then(({ default: app }) => TestApp.fromApp(app))',
        '    .catch((error: unknown) => {',
        `      throw new Error(\`${SKELETON_BOOT_FAILED} \${error instanceof Error ? error.message : String(error)}\`, { cause: error })`,
        '    })',
        '  return booted',
        '}',
      ].join('\n'),
      [
        '/** The application, acting as `actor` when given; primed for CSRF where it is mounted. */',
        'async function client(actor?: object): Promise<TestApp> {',
        '  const http = actor === undefined ? await ready() : (await ready()).actingAs(actor)',
        '  try {',
        '    return await http.withCsrf()',
        '  } catch (error) {',
        '    // For an application with no CSRF middleware, which issues no XSRF-TOKEN; one mounting it with `cookie: false` is not handled.',
        `    if (error instanceof Error && error.message.startsWith(${quoteString(PLAN_TESTS_CSRF_ABSENT)})) return http`,
        '    throw error',
        '  }',
        '}',
      ].join('\n'),
      [
        '// A beforeAll that throws fails as one unnamed case, so the failure is printed for plan:verify and kept in',
        "// `booted` for each test to rethrow by name. Bun's hook timeout defaults to 5 s, shorter than some boots.",
        'beforeAll(async () => {',
        '  await ready().catch((error: unknown) => {',
        '    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)',
        '  })',
        '}, 120_000)',
      ].join('\n'),
      ...(this.usesGiven
        ? ["/** Setup the plan states in prose: replace each call with that setup, or the test fails here. */\nfunction given<T = void>(setup: string): T {\n  throw new Error(`Write this setup first: ${setup}`)\n}"]
        : []),
      ...(this.usesUnwritten
        ? ["/** An expectation the plan states that plan:scaffold could not write: replace each call with the assertion. */\nfunction unwritten(expectation: string): void {\n  throw new Error(`Write this assertion first: ${expectation}`)\n}"]
        : []),
    ]
    return `${imports.join('\n')}\n\n${helpers.join('\n\n')}\n\ndescribe(${quoteString(prose(describeName))}, () => {\n${tests.join('\n\n')}\n})\n`
  }
}

function describeTask(plan: PlanDraft, task: PlanDerivedTask): string {
  switch (task.title.kind) {
    case 'foundation':
      return `${plan.title}: foundation`
    case 'entity':
    case 'story':
      return task.title.name
    case 'cross':
      return task.title.models.join(', ')
  }
}

/** What `plan:scaffold` writes for a `tests` step. Pure: the caller reads the application and writes the result. */
export function emitPlanTests(plan: PlanDraft, task: PlanDerivedTask, step: PlanDerivedStep, context: { slug: string; planFile: string }, app: PlanTestsApp): PlanTestsOutput {
  const path = planTestsFilePath(context.slug, task)
  const emitter = new TestsEmitter(plan, path, app)
  const wanted = new Set(step.acceptanceIds)
  const behaviours = plan.tasks.flatMap((intent) => intent.acceptance).filter((behaviour) => wanted.has(behaviour.id))
  const tests = behaviours.map((behaviour) => emitter.test(behaviour))
  const contents = emitter.source(context.planFile, step.id, describeTask(plan, task), tests)
  // A body, a database value, an error key or a page name is written as the plan spells it, and plan:verify would select the file by an id in it.
  const foreign = [...new Set(bracketedTokens(contents).filter((token) => isAcceptanceId(token) && !wanted.has(token)))]
  for (const id of foreign) emitter.refusals.push(`[${id}] would be carried by ${path}, which is not a behaviour of this step; plan:verify needs each behaviour in one test file.`)
  return {
    file: { elements: behaviours.map((behaviour) => behaviour.id), path, contents },
    unwritten: emitter.unwritten,
    mayPassNow: emitter.mayPassNow,
    refusals: emitter.refusals,
  }
}
