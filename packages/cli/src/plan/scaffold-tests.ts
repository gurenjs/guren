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
import { isBindingName, PATH_PARAM_PATTERN, quoteObjectKey } from '../utils'
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
  /** Why nothing may be written. Non-empty means the output is not to be used. */
  refusals: string[]
}

/** Names the file declares itself, which a parameter or a model import must not take. */
const FILE_NAMES: ReadonlySet<string> = new Set(['describe', 'expect', 'test', 'TestApp', 'booted', 'client', 'given', 'unwritten', 'actor', 'response', 'body'])

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

/** Where a task's skeletons go: one file per plan and task, so a second plan on the same entity writes a file of its own. */
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

function templateText(text: string): string {
  return text.replace(/[\\`]/gu, '\\$&').replace(/\$\{/gu, '\\${')
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

interface PathParam {
  label: string
  variable: string
}

/** A route path as code, each parameter a whole-segment interpolation, which is what `test-requests.ts` reads as filling it. */
class RequestPath {
  readonly params: PathParam[] = []

  constructor(private readonly taken: ReadonlySet<string>) {}

  private variable(label: string): string {
    const known = this.params.find((param) => param.label === label)
    if (known) return known.variable
    const base = isBindingName(label) && !this.taken.has(label) ? label : `param${this.params.length + 1}`
    this.params.push({ label, variable: base })
    return base
  }

  /** `null` for a path naming a parameter the route does not declare, which only the route can fill. */
  code(path: string, suffix = '', declared?: ReadonlySet<string>): string | null {
    const pieces: string[] = []
    let last = 0
    let dynamic = false
    for (const match of path.matchAll(PATH_PARAM_PATTERN)) {
      const [token, boundary] = match
      const label = match[2]!.replace(/\*$/u, '')
      if (declared && !declared.has(label)) return null
      pieces.push(templateText(path.slice(last, match.index) + boundary), `\${${this.variable(label)}}`)
      last = match.index + token.length
      dynamic = true
    }
    let rest = path.slice(last)
    // A bare `*` segment takes any value, which the test has to choose like a parameter's.
    if (/(^|\/)\*(?=\/|$)/u.test(rest) && !declared) {
      rest = rest.replace(/(^|\/)\*(?=\/|$)/gu, (_, slash: string) => `${slash}\u0000`)
      const [head, ...tail] = templateText(rest).split('\u0000')
      pieces.push(head!, ...tail.flatMap((piece) => [`\${${this.variable('wildcard')}}`, piece]))
      dynamic = true
    } else {
      pieces.push(templateText(rest))
    }
    if (!dynamic) return quoteString(path + suffix)
    return `\`${pieces.join('')}${templateText(suffix)}\``
  }
}

interface Written {
  lines: string[]
  /** An assertion a 404 from a route that does not exist yet would fail, so the case cannot pass before the implementation. */
  failsUnrouted: boolean
}

/** A has/missing value the where clause can take, typed as the model record types the column. */
function whereValue(column: PlanColumn, value: unknown): boolean {
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
  readonly refusals: string[] = []
  readonly models = new Map<string, string>()
  usesGiven = false
  usesUnwritten = false
  usesExpect = false

  constructor(
    private readonly plan: PlanDraft,
    private readonly path: string,
    private readonly app: PlanTestsApp,
  ) {}

  private leave(behaviour: PlanAcceptance, detail: string, reason: string, lines: string[]): void {
    this.unwritten.push({ element: behaviour.id, detail, reason })
    this.usesUnwritten = true
    lines.push(`    unwritten(${quoteString(prose(`${detail}: ${reason}`))})`)
  }

  private needsUser(behaviour: PlanAcceptance, route: PlanRoute): boolean {
    if (behaviour.kind === 'unauthenticated') return false
    const action = this.plan.controllers.flatMap((controller) => controller.actions).find((candidate) => candidate.id === route.action)
    const middleware = [...route.middleware, ...(action?.authorization.middleware ?? [])]
    return behaviour.kind === 'forbidden' || action?.authorization.policy !== undefined || middleware.some((name) => name === 'auth' || name.startsWith('auth:'))
  }

  /** The model class a database row is read through, imported from the root; `undefined` when the row cannot be. */
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
        else if (!whereValue(column, parsed)) reason ??= `${value.json} is no literal a ${column.type}${column.nullable ? ' (nullable)' : ''} column compares with`
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
    const route = this.plan.routes.find((candidate) => candidate.id === behaviour.route)
    if (!route) {
      this.refusals.push(`${behaviour.id} names the route ${behaviour.route}, which the plan does not declare.`)
      return ''
    }

    for (const setup of behaviour.given) lines.push(`    given(${quoteString(prose(setup))})`)
    const user = this.needsUser(behaviour, route)
    if (user) lines.push(`    const actor = given<object>(${quoteString(`the actor: ${prose(behaviour.actor)}`)})`)

    const taken = new Set([...FILE_NAMES, ...this.models.keys(), ...this.plan.models.map((model) => model.name)])
    const path = new RequestPath(taken)
    const safe = route.method === 'GET'
    const url = path.code(route.path, safe ? queryString(behaviour.input) : '')!
    for (const param of path.params) lines.push(`    const ${param.variable} = given<number | string>(${quoteString(`the :${param.label} parameter`)})`)
    if (path.params.length > 0 || behaviour.given.length > 0 || user) this.usesGiven = true

    const body = !safe && behaviour.input?.length ? `, ${literal(Object.fromEntries(behaviour.input.map(({ name, json }) => [name, parseJson(json)])))}` : ''
    const view = behaviour.expect.inertia === undefined ? undefined : this.plan.views.find((candidate) => candidate.id === behaviour.expect.inertia)
    const receiver = `(await client(${user ? 'actor' : ''}))${view ? ".withHeaders({ 'X-Inertia': 'true' })" : ''}`
    const chain: string[] = []
    const written: Written = { lines: [], failsUnrouted: false }
    const { status, redirect, errors } = behaviour.expect
    if (status !== undefined) {
      chain.push(`.assertStatus(${status})`)
      if (status !== 404) written.failsUnrouted = true
    }
    if (redirect !== undefined) {
      const target = path.code(redirect, '', new Set(path.params.map((param) => param.label)))
      if (target === null) this.leave(behaviour, `redirect ${redirect}`, 'it names a parameter the route does not, whose value only the implementation knows', written.lines)
      else {
        chain.push(`.assertRedirect(${target})`)
        written.failsUnrouted = true
      }
    }
    if (behaviour.expect.inertia !== undefined) {
      if (view) {
        chain.push(`.assertInertia(${quoteString(view.page)})`)
        written.failsUnrouted = true
      } else this.leave(behaviour, `inertia ${behaviour.expect.inertia}`, 'the plan declares no such view', written.lines)
    }
    const request = `${receiver}.${route.method.toLowerCase()}(${url}${body})${chain.join('')}`
    if (errors?.length) {
      this.usesExpect = true
      lines.push(`    const response = await ${request}`)
      lines.push('    const body = await response.json<{ errors?: Record<string, unknown> }>()')
      lines.push(`    expect(Object.keys(body.errors ?? {})).toEqual(expect.arrayContaining([${errors.map((field) => quoteString(field)).join(', ')}]))`)
      written.failsUnrouted = true
    } else {
      lines.push(`    await ${request}`)
    }
    lines.push(...written.lines)
    for (const row of behaviour.expect.database ?? []) {
      if (this.databaseRow(behaviour, row, lines)) written.failsUnrouted = true
    }
    if (status === 404) {
      this.leave(behaviour, 'status 404', 'a route that does not exist yet answers 404 as well, so assert what tells the two apart', lines)
    } else if (!written.failsUnrouted) {
      this.leave(behaviour, 'expect', 'nothing written here fails against a route that does not exist yet, so assert what the behaviour changes', lines)
    }
    return `  test(${title}, async () => {\n${lines.join('\n')}\n  })`
  }

  source(planFile: string, stepId: string, describeName: string, tests: readonly string[]): string {
    const testImports = ['describe', ...(this.usesExpect ? ['expect'] : []), 'test']
    const imports = [
      `import { ${testImports.join(', ')} } from 'bun:test'`,
      "import { TestApp } from '@guren/testing'",
      ...[...this.models].sort(([left], [right]) => (left < right ? -1 : 1)).map(([name, file]) => `import { ${name} } from '${importSpecifier(this.path, file)}'`),
    ]
    const helpers = [
      [
        `// Written by plan:scaffold from ${prose(planFile)} (${stepId}). Keep each title's id and the request`,
        '// it makes: plan:verify finds a behaviour by its id, and each test fails until its implementation exists.',
        'let booted: Promise<TestApp> | undefined',
      ].join('\n'),
      [
        '/** The application, booted inside a test so a boot that fails fails each test by name; primed for CSRF where it is mounted. */',
        'async function client(actor?: object): Promise<TestApp> {',
        `  booted ??= import('${importSpecifier(this.path, this.app.entry)}').then(({ default: app }) => TestApp.fromApp(app))`,
        '  const http = actor === undefined ? await booted : (await booted).actingAs(actor)',
        '  try {',
        '    return await http.withCsrf()',
        '  } catch (error) {',
        '    // CSRF middleware issues XSRF-TOKEN on every safe request, so its absence means there is none to prime.',
        "    if (error instanceof Error && error.message.includes('XSRF-TOKEN')) return http",
        '    throw error',
        '  }',
        '}',
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
      return task.title.name
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
  return {
    file: { elements: behaviours.map((behaviour) => behaviour.id), path, contents: emitter.source(context.planFile, step.id, describeTask(plan, task), tests) },
    unwritten: emitter.unwritten,
    refusals: emitter.refusals,
  }
}
