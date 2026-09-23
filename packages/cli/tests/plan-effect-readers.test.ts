import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { definePolicy } from '@guren/core'

import type { PlanAppDetail, PlanAppPolicyDetail, PlanAppSideEffectDetail } from '../src/plan/app-detail'
import { loadPlanAppState, type PlanAppState } from '../src/plan/app-state'
import { describeCloseBlockers } from '../src/plan/close-remedy'
import { DEFINE_POLICY_ABILITIES } from '../src/plan/policy-abilities'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import type { PlanStepRecord } from '../src/plan/state'
import { judgePlan, type PlanElementState, type PlanElementStatus } from '../src/plan/status'
import { derivePlanTasks, listPlanSteps } from '../src/plan/tasks'
import { applyVerification } from '../src/plan/verification'
import { createTempRoot, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'
import { planAppState } from './plan-fixture'

const ADD = { kind: 'add' } as const

function plan(sections: Record<string, unknown>): PlanDraft {
  return PlanDraftSchema.parse({
    planVersion: 1,
    title: 'Effect readers',
    summary: 'A plan for the policy and side-effect readers.',
    locale: 'en',
    scope: { goals: [], nonGoals: [] },
    models: [{ id: 'm', change: { kind: 'existing' }, name: 'Post', table: 'posts', columns: [], relationships: [], fillable: [] }],
    ...sections,
  })
}

function policyPlan(abilities: Array<{ name: string; rule: string }>): PlanDraft {
  return plan({ policies: [{ id: 'pol', change: ADD, name: 'PostPolicy', model: 'm', abilities }] })
}

function effectPlan(kind: string, name: string): PlanDraft {
  return plan({ sideEffects: [{ id: 'fx', change: ADD, kind, name, trigger: 'when a post is published', description: 'd' }] })
}

const NO_SIDE_EFFECTS: PlanAppDetail['sideEffects'] = { job: [], event: [], listener: [], mail: [], notification: [] }

function state(detail: Partial<Pick<PlanAppDetail, 'policies' | 'sideEffects' | 'sideEffectUsesUnread'>>): PlanAppState {
  return planAppState({
    detail: {
      routes: [],
      mounts: { entry: 'mounted', modules: {} },
      tables: [],
      models: [],
      unparsedModelFiles: [],
      actions: [],
      controllers: [],
      controllerCollisions: [],
      pages: [],
      validators: [],
      resources: [],
      resourcePayloads: [],
      policies: [],
      routeFiles: [],
      sideEffects: NO_SIDE_EFFECTS,
      ...detail,
    },
  })
}

function policy(abilities: PlanAppPolicyDetail['abilities']): PlanAppPolicyDetail {
  return { className: 'PostPolicy', module: null, file: 'app/Policies/PostPolicy.ts', abilities }
}

type Uses = Partial<Pick<PlanAppSideEffectDetail, 'usedIn' | 'unprovenIn' | 'mentionedIn'>>

function effect(className: string, file: string, uses: Uses = {}): PlanAppSideEffectDetail {
  return { className, module: null, file, usedIn: [], unprovenIn: [], mentionedIn: [], ...uses }
}

function only(document: PlanDraft, app: PlanAppState, id: string): PlanElementStatus {
  const element = judgePlan(document, app).elements.find((candidate) => candidate.id === id)
  if (!element) throw new Error(`no element ${id}`)
  return element
}

/** The element after every step of the plan is recorded as verified, with no behaviour run. */
function liftEveryStep(document: PlanDraft, app: PlanAppState, id: string, file: string): PlanElementStatus<PlanElementState> {
  const derivation = derivePlanTasks(document)
  const record: PlanStepRecord = {
    outcome: 'verified',
    planDigest: 'digest',
    ranAt: 't',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: { files: { [file]: 'h' }, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
  }
  const records = Object.fromEntries(listPlanSteps(derivation).map(({ step }) => [step.id, record]))
  const lifted = applyVerification(judgePlan(document, app), derivation, records, 'digest', new Map([[file, 'h']]), document)
  return lifted.status.elements.find((element) => element.id === id)!
}

const verdicts = (element: PlanElementStatus): Record<string, string> =>
  Object.fromEntries(element.properties.map((property) => [property.property, property.verdict]))

describe('judgePlan on policy abilities', () => {
  test('should match a planned ability the policy declares, and leave its prose rule unknown', () => {
    const element = only(policyPlan([{ name: 'delete', rule: 'the author' }]), state({ policies: [policy({ declared: ['view', 'delete'], fields: [] })] }), 'pol')

    expect(verdicts(element)).toEqual({ 'ability delete': 'match', 'ability delete rule': 'unknown' })
    expect(element.state).toBe('present')
  })

  test('should differ on a planned ability the policy does not declare', () => {
    const element = only(policyPlan([{ name: 'delete', rule: 'the author' }]), state({ policies: [policy({ declared: ['view'], fields: [] })] }), 'pol')

    expect(element.properties[0]).toMatchObject({ property: 'ability delete', verdict: 'differ', actual: 'not declared' })
    expect(element.state).toBe('drifted')
  })

  test('should leave an ability unknown where the class may hold it unread, never differ', () => {
    const asField = only(policyPlan([{ name: 'delete', rule: 'r' }]), state({ policies: [policy({ declared: [], fields: ['delete'] })] }), 'pol')
    const inherited = only(policyPlan([{ name: 'delete', rule: 'r' }]), state({ policies: [policy({ declared: [], fields: [], open: 'it extends BasePolicy, whose abilities are not read' })] }), 'pol')

    for (const element of [asField, inherited]) {
      expect(verdicts(element)['ability delete']).toBe('unknown')
      expect(element.state).toBe('unjudged')
    }
  })

  test('should differ on a definePolicy key the class it returns never exposes', () => {
    const element = only(policyPlan([{ name: 'publish', rule: 'an editor' }]), state({ policies: [policy({ declared: ['publish'], fields: [], exposes: DEFINE_POLICY_ABILITIES })] }), 'pol')

    expect(element.properties[0]).toMatchObject({ verdict: 'differ', actual: expect.stringContaining('definePolicy() exposes only viewAny') })
  })

  test('should not let a policy verify on ability names alone, which make:policy writes into every policy', () => {
    const lifted = liftEveryStep(policyPlan([{ name: 'update', rule: 'only the author' }]), state({ policies: [policy({ declared: ['update'], fields: [] })] }), 'pol', 'app/Policies/PostPolicy.ts')

    expect(lifted).toMatchObject({ state: 'present', hold: { kind: 'unreached' } })
  })

  test('should send a policy that matches only by ability names to plan:waive, since no plan:verify run lifts it', () => {
    const document = policyPlan([{ name: 'update', rule: 'only the author' }])
    const lifted = liftEveryStep(document, state({ policies: [policy({ declared: ['update'], fields: [] })] }), 'pol', 'app/Policies/PostPolicy.ts')

    const [blocker] = describeCloseBlockers(document, derivePlanTasks(document), [lifted], 'p.json')

    expect(blocker!.moves).toStartWith("No planned property of it matched beyond its existence and no step's behaviour reaches it")
    expect(blocker!.moves).toContain('plan:waive')
  })

  test('should hold an ability name and a key existence alike, and lift a shape match, on one plan', () => {
    const document = plan({
      policies: [{ id: 'pol', change: ADD, name: 'PostPolicy', model: 'm', abilities: [{ name: 'update', rule: 'only the author' }] }],
      resources: [
        { id: 'res.keys', change: ADD, name: 'PostResource', model: 'm', fields: [{ name: 'body', type: 'string' }] },
        { id: 'res.shape', change: ADD, name: 'TagResource', model: 'm', fields: [{ name: 'label', type: 'string' }] },
      ],
    })
    const payload = (className: string, name: string, type: string) => ({ className, module: null, file: `app/Http/Resources/${className}.ts`, payload: { members: [{ name, type, optional: false }] } })
    const app = planAppState({
      resources: ['PostResource', 'TagResource'],
      detail: {
        ...state({ policies: [policy({ declared: ['update'], fields: [] })] }).detail!,
        resources: ['PostResource', 'TagResource'].map((className) => ({ className, module: null, file: `app/Http/Resources/${className}.ts` })),
        resourcePayloads: [payload('PostResource', 'body', 'BodyAlias'), payload('TagResource', 'label', 'string')],
      },
    })
    const derivation = derivePlanTasks(document)
    const record: PlanStepRecord = {
      outcome: 'verified',
      planDigest: 'digest',
      ranAt: 't',
      durationMs: 1,
      commands: [],
      acceptance: [],
      incomplete: [],
      waived: [],
      fingerprint: { files: {}, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
    }
    const files = ['app/Policies/PostPolicy.ts', 'app/Http/Resources/PostResource.ts', 'app/Http/Resources/TagResource.ts']
    record.fingerprint.files = Object.fromEntries(files.map((file) => [file, 'h']))
    const records = Object.fromEntries(listPlanSteps(derivation).map(({ step }) => [step.id, record]))
    const lifted = applyVerification(judgePlan(document, app), derivation, records, 'digest', new Map(files.map((file) => [file, 'h'])), document).status.elements
    const byId = (id: string) => lifted.find((element) => element.id === id)!

    expect(byId('pol').properties.find((property) => property.property === 'ability update')).toMatchObject({ verdict: 'match', existence: true })
    expect(byId('res.keys').properties.find((property) => property.property === 'field body')).toMatchObject({ verdict: 'match', existence: true })
    expect(byId('pol').hold?.kind).toBe('unreached')
    expect(byId('res.keys').hold?.kind).toBe('unreached')
    expect(byId('res.shape').state).toBe('verified')
    const blockers = describeCloseBlockers(document, derivation, [byId('pol'), byId('res.keys')], 'p.json')
    for (const blocker of blockers) expect(blocker.moves).toStartWith("No planned property of it matched beyond its existence and no step's behaviour reaches it")
  })

  test('should call a policy whose class could not be resolved unjudged, with every ability unknown', () => {
    const element = only(policyPlan([{ name: 'delete', rule: 'r' }]), state({ policies: [policy({ unreadable: 'the file declares no class PostPolicy' })] }), 'pol')

    expect(element.properties[0]).toMatchObject({ verdict: 'unknown', reason: expect.stringContaining('declares no class PostPolicy') })
    expect(element.state).toBe('unjudged')
  })
})

describe('judgePlan on side effects', () => {
  const posted = (uses: Uses) =>
    state({ sideEffects: { ...NO_SIDE_EFFECTS, event: [effect('PostPublished', 'app/Events/PostPublished.ts', uses)] } })

  test('should call an event the application emits wired, completing there', () => {
    const element = only(effectPlan('event', 'PostPublished'), posted({ usedIn: ['app/Http/Controllers/PostController.ts'] }), 'fx')

    expect(element.state).toBe('wired')
    expect(element.completesAt).toBe('wired')
    expect(element.properties).toEqual([])
  })

  test('should hold an event nothing emits at present, naming the file that only mentions it', () => {
    const element = only(effectPlan('event', 'PostPublished'), posted({ mentionedIn: ['app/Listeners/Notify.ts'] }), 'fx')

    expect(element.state).toBe('present')
    expect(element.notes).toEqual(["Not confirmed as wired: nothing in the application's source emits it (app/Listeners/Notify.ts names it without emitting it)."])
  })

  test('should hold a listener only an on() handler with no event class refers to at present, saying why', () => {
    const app = state({ sideEffects: { ...NO_SIDE_EFFECTS, listener: [effect('NotifyAuthor', 'app/Listeners/NotifyAuthor.ts', { unprovenIn: ['app/Providers/EventServiceProvider.ts'] })] } })

    const element = only(effectPlan('listener', 'NotifyAuthor'), app, 'fx')

    expect(element.state).toBe('present')
    expect(element.notes[0]).toContain('app/Providers/EventServiceProvider.ts refers to it in an on() or once() handler whose event is not an event class')
  })

  test('should not call a side effect wired when a source file the scan needed did not parse', () => {
    const app = state({
      sideEffects: { ...NO_SIDE_EFFECTS, job: [effect('SendDigest', 'app/Jobs/SendDigest.ts')] },
      sideEffectUsesUnread: { job: 'app/Broken.ts could not be parsed' },
    })

    const element = only(effectPlan('job', 'SendDigest'), app, 'fx')

    expect(element.state).toBe('present')
    expect(element.notes[0]).toContain('app/Broken.ts could not be parsed')
  })

  test('should judge a mail and a notification class, which are discovered now', () => {
    const app = state({
      sideEffects: {
        ...NO_SIDE_EFFECTS,
        mail: [effect('WelcomeMail', 'app/Mail/WelcomeMail.ts', { usedIn: ['app/Jobs/SendWelcome.ts'] })],
        notification: [effect('PostPublishedNotification', 'app/Notifications/PostPublishedNotification.ts')],
      },
    })

    expect(only(effectPlan('mail', 'WelcomeMail'), app, 'fx').state).toBe('wired')
    expect(only(effectPlan('notification', 'PostPublishedNotification'), app, 'fx').state).toBe('present')
  })

  test('should not let a wired side effect verify without a behaviour that reaches it', () => {
    const lift = (usedIn: string[]) =>
      liftEveryStep(
        effectPlan('job', 'SendDigest'),
        state({ sideEffects: { ...NO_SIDE_EFFECTS, job: [effect('SendDigest', 'app/Jobs/SendDigest.ts', { usedIn })] } }),
        'fx',
        'app/Jobs/SendDigest.ts',
      )

    expect(lift(['app/Http/Controllers/DigestController.ts'])).toMatchObject({ state: 'wired', hold: { kind: 'unreached' } })
    expect(lift([])).toMatchObject({ state: 'present', hold: { kind: 'incomplete' } })
  })
})

// One directory per application: Bun keys an imported routes file on its path.
const ROOT_PREFIX = 'guren-plan-effect-readers-'
let ROOT: string

const APP_FILES: Record<string, string> = {
  'bunfig.toml': '[install]\nauto = "disable"\n',
  'src/app.ts': "import { createApp } from '@guren/core'\nimport { registerWebRoutes } from '../routes/web.js'\n\nexport default createApp({ routes: registerWebRoutes })\n",
  'routes/web.ts': "import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(router: Router): void {\n  void router\n}\n",

  'app/Events/PostPublished.ts': "import { Event } from '@guren/core'\n\nexport class PostPublished extends Event {}\n",
  'app/Events/PostArchived.ts': "import { Event } from '@guren/core'\n\nexport class PostArchived extends Event {}\n",
  'app/Events/PostDrafted.ts': "import { Event } from '@guren/core'\n\nexport class PostDrafted extends Event {}\n",
  'app/Events/index.ts': "export * from './PostDrafted.js'\n",
  'app/Jobs/SendDigest.ts': "import { Job } from '@guren/core'\n\nexport class SendDigest extends Job<void> {\n  async handle(): Promise<void> {}\n}\n",
  'app/Jobs/Reindex.ts': "import { Job } from '@guren/core'\n\nexport class Reindex extends Job<void> {\n  async handle(): Promise<void> {}\n}\n",
  'app/Jobs/Prune.ts': "import { Job } from '@guren/core'\n\nexport class Prune extends Job<void> {\n  async handle(): Promise<void> {}\n}\n",
  'app/Jobs/Orphan.ts': "import { Job } from '@guren/core'\n\nexport class Orphan extends Job<void> {\n  async handle(): Promise<void> {\n    await Orphan.dispatch(undefined)\n  }\n}\n",
  'app/Listeners/LogPost.ts': "import { Listener } from '@guren/core'\n\nexport class LogPost extends Listener {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/NotifyAuthor.ts': "export class NotifyAuthor {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/Idle.ts': "export class Idle {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/ByName.ts': "export class ByName {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/OptionsOnly.ts': "export class OptionsOnly {\n  static priority = 5\n}\n",
  'app/Listeners/Quiet.ts': "export class Quiet {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/NsTo.ts': "export class NsTo {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/NameRead.ts': "export class NameRead {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/Unrun.ts': "export class Unrun {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/NsStatic.ts': "export class NsStatic {\n  static async handle(_event?: unknown): Promise<void> {}\n}\n",
  'app/Listeners/Invoked.ts': "export class Invoked {\n  async handle(_event?: unknown): Promise<void> {}\n}\n",
  'app/Listeners/StrBound.ts': "export class StrBound {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/Called.ts': "export class Called {\n  async handle(_event?: unknown): Promise<void> {}\n}\n",
  'app/Listeners/Bound.ts': "export class Bound {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/ParamA.ts': "export class ParamA {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/ParamB.ts': "export class ParamB {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/VarLoop.ts': "export class VarLoop {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/WrappedL.ts': "export class WrappedL {\n  async handle(): Promise<void> {}\n}\n",
  'app/Listeners/AuthLogger.ts': "export class AuthLogger {\n  async handle(): Promise<void> {}\n}\n",
  'app/Mail/WelcomeMail.ts': "import { Mail } from '@guren/core'\n\nexport class WelcomeMail extends Mail {}\n",
  'app/Mail/DraftMail.ts': "import { Mail } from '@guren/core'\n\nexport class DraftMail extends Mail {}\n",
  'app/Mail/ResetMail.ts': "export async function sendResetMail(to: string): Promise<void> {\n  void to\n}\n",
  'app/Mail/NoticeMail.ts': "import { Mail } from '@guren/core'\n\nexport class NoticeMail extends Mail {}\n",
  'app/Mail/ReceiptMail.ts': "import { Mail } from '@guren/core'\n\nexport class ReceiptMail extends Mail {}\n",
  'app/Events/PostQueued.ts': "import { Event } from '@guren/core'\n\nexport class PostQueued extends Event {}\n",
  'app/Services/Mailer.ts': `import type { EventManager, MailManager } from '@guren/core'
import { NoticeMail } from '../Mail/NoticeMail.js'
import { ReceiptMail } from '../Mail/ReceiptMail.js'
import { PostQueued } from '../Events/PostQueued.js'
import { PostSwitched } from '../Events/PostSwitched.js'
import { PostWarmed } from '../Events/PostWarmed.js'
import { PostChained } from '../Events/PostChained.js'

export async function deliver(kind: string, manager: MailManager): Promise<void> {
  switch (kind) {
    case 'notice': {
      const mail = new NoticeMail(manager)
      await mail.send()
      break
    }
    case 'receipt': {
      const mail = new ReceiptMail(manager)
      void mail
      break
    }
  }
}

export async function queue(events: EventManager, event = new PostQueued()): Promise<void> {
  await events.emit(event)
}

export async function chained(events: EventManager): Promise<void> {
  var first = new PostChained(), second = first
  await events.emit(second)
}

export async function swapped(manager: MailManager): Promise<void> {
  let current = new NoticeMail(manager)
  current = new ReceiptMail(manager)
  await current.send()
}

export async function destructured(manager: MailManager, others: { current: ReceiptMail }): Promise<void> {
  let held = new ReceiptMail(manager)
  ;({ current: held } = others)
  await held.send()
}

export async function looped(manager: MailManager, others: ReceiptMail[]): Promise<void> {
  let each = new ReceiptMail(manager)
  for (each of others) await each.send()
}

export async function either(ready: boolean, manager: MailManager): Promise<void> {
  if (ready) {
    var mail = new NoticeMail(manager)
  } else {
    var mail = new ReceiptMail(manager)
  }
  await mail.send()
}

export async function route(events: EventManager): Promise<void> {
  const signal = new PostSwitched()
  switch (await events.emit(signal)) {
    default: {
      const signal = 1
      void signal
    }
  }
}

export class Warmup {
  static events = { emit: (event: unknown) => event }

  static {
    var started = new PostWarmed()
    void Warmup.events.emit(started)
  }
}
`,
  'app/Events/PostSwitched.ts': "import { Event } from '@guren/core'\n\nexport class PostSwitched extends Event {}\n",
  'app/Events/PostWarmed.ts': "import { Event } from '@guren/core'\n\nexport class PostWarmed extends Event {}\n",
  'app/Events/PostChained.ts': "import { Event } from '@guren/core'\n\nexport class PostChained extends Event {}\n",
  'app/Services/Hooks.ts': `import { Idle } from '../Listeners/Idle.js'
import { ByName } from '../Listeners/ByName.js'

export function hooks(router: { on(...args: unknown[]): void }, events: { on(...args: unknown[]): void }): void {
  router.on('POST', '/idle', () => new Idle().handle())
  const byName = new ByName()
  events.on('post.created', () => byName.handle())
}
`,
  'app/Notifications/PostPublishedNotification.ts': 'export class PostPublishedNotification {\n  via(): string[] {\n    return []\n  }\n}\n',

  'app/Http/Controllers/PostController.ts': `import { Controller, type Mail as MailType } from '@guren/core'
import { PostPublished } from '../../Events/PostPublished.js'
import { PostArchived } from '../../Events/PostArchived.js'
import { PostDrafted } from '../../Events/index.js'
import * as Jobs from '../../Jobs/SendDigest.js'
import { Reindex } from '../../Jobs/Reindex.js'
import { WelcomeMail } from '../../Mail/WelcomeMail.js'
import { DraftMail } from '../../Mail/DraftMail.js'
import { sendResetMail } from '../../Mail/ResetMail.js'
import { PostPublishedNotification } from '../../Notifications/PostPublishedNotification.js'

export class PostController extends Controller {
  async store() {
    await this.make('events').emit(new PostPublished())
    const drafted = new PostDrafted()
    await this.make('events').emitParallel(drafted)
    await Jobs.SendDigest.dispatch(undefined)
    await new WelcomeMail(this.make('mail')).to('a@example.com').send()
    await sendResetMail('a@example.com')
    await this.make('notifications').sendNow({ id: 1 }, new PostPublishedNotification())
    // await this.make('events').emit(new PostArchived()); Reindex.dispatch(undefined)
    const label = 'Reindex.dispatch(undefined) new PostArchived()'
    const draft: DraftMail = new DraftMail(this.make('mail'))
    let archived: PostArchived | undefined
    void label
    void draft
    void archived
    void (null as unknown as MailType)
    return this.redirect('/posts')
  }

  async destroy(PostArchived: { emit(): void }) {
    PostArchived.emit()
    return this.redirect('/posts')
  }
}
`,
  'app/Providers/EventServiceProvider.ts': `import { ServiceProvider, UserAuthenticated, registerJob, type EventManager } from '@guren/core'
import { PostPublished } from '../Events/PostPublished.js'
import { LogPost } from '../Listeners/LogPost.js'
import { NotifyAuthor } from '../Listeners/NotifyAuthor.js'
import { Idle } from '../Listeners/Idle.js'
import { OptionsOnly } from '../Listeners/OptionsOnly.js'
import { AuthLogger } from '../Listeners/AuthLogger.js'
import { Quiet } from '../Listeners/Quiet.js'
import { Reindex } from '../Jobs/Reindex.js'

export default class EventServiceProvider extends ServiceProvider {
  boot(): void {
    registerJob(Reindex)
    const events = this.container.make<EventManager>('events')
    events.listen(LogPost)
    const notifyAuthor = new NotifyAuthor()
    events.on(PostPublished, async () => {
      await notifyAuthor.handle()
    })
    events.on(PostPublished, () => OptionsOnly.toString(), { priority: OptionsOnly.priority })
    const quiet = new Quiet()
    events.on(PostPublished, () => void quiet)
    events.once(UserAuthenticated, () => new AuthLogger().handle())
    const idle: Idle | null = null
    void idle
  }
}
`,
  'app/Providers/EdgeProvider.ts': `import type { EventManager } from '@guren/core'
import { PostPublished } from '../Events/PostPublished.js'
import * as Namespaced from '../Listeners/NsTo.js'
import * as StaticNs from '../Listeners/NsStatic.js'
import { NameRead } from '../Listeners/NameRead.js'
import { Bound } from '../Listeners/Bound.js'
import { Unrun } from '../Listeners/Unrun.js'
import { Called } from '../Listeners/Called.js'
import { Invoked } from '../Listeners/Invoked.js'
import { StrBound } from '../Listeners/StrBound.js'
import { ParamA } from '../Listeners/ParamA.js'
import { ParamB } from '../Listeners/ParamB.js'
import { VarLoop } from '../Listeners/VarLoop.js'
import { WrappedL } from '../Listeners/WrappedL.js'

export function edges(events: EventManager, others: VarLoop[], other: WrappedL): void {
  events.on(PostPublished, () => Namespaced.NsTo.toString())
  events.on(PostPublished, () => NameRead.name.toUpperCase())
  const bound = new Bound()
  events.on(PostPublished, bound.handle.bind(bound))
  const unrun = new Unrun()
  events.on(PostPublished, () => unrun.handle.bind(unrun))
  const called = new Called()
  events.on(PostPublished, (event) => called.handle.call(called, event))
  const invoked = new Invoked()
  events.on(PostPublished, (event) => invoked.handle.bind(invoked)(event))
  events.on(PostPublished, (event) => StaticNs.NsStatic.handle.bind(StaticNs.NsStatic)(event))
  const byString = new StrBound()
  events.on('post.bound', byString.handle.bind(byString))
  var looped = new VarLoop()
  for (var looped of others) events.on(PostPublished, () => looped.handle())
  let wrapped = new WrappedL()
  ;(wrapped as unknown) = other
  events.on(PostPublished, () => wrapped.handle())
}

export function conflicted(events: EventManager, chosen = new ParamA(), flip = true): void {
  if (flip) {
    var chosen = new ParamB()
  }
  events.on(PostPublished, () => chosen.handle())
}
`,
  'app/Console/Kernel.ts': `import type { Schedule } from '@guren/core'
import { Prune } from '../Jobs/Prune.js'

export function schedule(schedule: Schedule): void {
  schedule.job(Prune, undefined).daily()
}
`,
  'app/Jobs/Prune.test.ts': "import { Orphan } from './Orphan.js'\n\nawait Orphan.dispatch(undefined)\n",

  'app/Policies/PostPolicy.ts': `import { Policy, type AuthUser } from '@guren/core'

const ownerOnly = (user: AuthUser | null) => user !== null

export class PostPolicy extends Policy {
  view(): boolean {
    return true
  }
  update = (user: AuthUser | null) => user !== null
  delete = ownerOnly
  get archive() {
    return ownerOnly
  }
  static restore(): boolean {
    return true
  }
}
`,
  'app/Policies/CommentPolicy.ts': `import { definePolicy } from '@guren/core'

const shared = {}

export const CommentPolicy = definePolicy({
  view: () => true,
  update() {
    return false
  },
  publish: () => true,
  ...shared,
})
`,
  'app/Policies/TagPolicy.ts': `import { BasePolicy } from './BasePolicy.js'

export class TagPolicy extends BasePolicy {
  view(): boolean {
    return true
  }
}
`,
  'app/Policies/LabelPolicy.ts': 'export const somethingElse = 1\n',
}

async function detailOf(name: string, files: Record<string, string> = {}): Promise<PlanAppState> {
  const dir = join(ROOT, name)
  await writeWorkspaceFiles(dir, { ...APP_FILES, ...files })
  await linkWorkspaceCore(dir)
  return loadPlanAppState(dir, { detail: true })
}

describe('the policy and side-effect readers', () => {
  let app: PlanAppState
  let detail: PlanAppDetail

  beforeAll(async () => {
    ROOT = await createTempRoot(ROOT_PREFIX)
    app = await detailOf('app')
    detail = app.detail!
  })

  const effectOf = (kind: keyof PlanAppDetail['sideEffects'], className: string) => {
    const found = detail.sideEffects[kind].find((entry) => entry.className === className)
    if (!found) throw new Error(`no ${kind} ${className}`)
    return found
  }

  test('should read a use off the framework call that takes the class, and nothing else', () => {
    const controller = 'app/Http/Controllers/PostController.ts'
    const provider = 'app/Providers/EventServiceProvider.ts'

    expect(effectOf('event', 'PostPublished').usedIn).toEqual([controller])
    // An instance held in a binding and emitted, through a barrel import.
    expect(effectOf('event', 'PostDrafted').usedIn).toEqual([controller])
    expect(effectOf('job', 'SendDigest').usedIn).toEqual([controller])
    expect(effectOf('job', 'Prune').usedIn).toEqual(['app/Console/Kernel.ts'])
    expect(effectOf('listener', 'LogPost').usedIn).toEqual([provider])
    // An instance a registered handler calls: the blog's own idiom.
    expect(effectOf('listener', 'NotifyAuthor').usedIn).toEqual([provider])
    expect(effectOf('mail', 'WelcomeMail').usedIn).toEqual([controller])
    // A mail module that declares no class is sent by calling its exported function.
    expect(effectOf('mail', 'ResetMail').usedIn).toEqual([controller])
    expect(effectOf('notification', 'PostPublishedNotification').usedIn).toEqual([controller])
    // Each case of a switch is a block of its own; the second binding of the name is another binding.
    expect(effectOf('mail', 'NoticeMail').usedIn).toEqual(['app/Services/Mailer.ts'])
    // A parameter defaulted to an instance holds it.
    expect(effectOf('event', 'PostQueued').usedIn).toEqual(['app/Services/Mailer.ts'])
    // The switch discriminant is read outside the cases' block, where another `signal` is bound.
    expect(effectOf('event', 'PostSwitched').usedIn).toEqual(['app/Services/Mailer.ts'])
    // A `var` in a static block is bound in the block's own function scope.
    expect(effectOf('event', 'PostWarmed').usedIn).toEqual(['app/Services/Mailer.ts'])
    // A later declarator of the same `var` statement sees the earlier one.
    expect(effectOf('event', 'PostChained').usedIn).toEqual(['app/Services/Mailer.ts'])
    // A bound member handed over as the handler, and a member run through call(), are the listener's own.
    expect(effectOf('listener', 'Bound').usedIn).toEqual(['app/Providers/EdgeProvider.ts'])
    expect(effectOf('listener', 'Called').usedIn).toEqual(['app/Providers/EdgeProvider.ts'])
    // A bound member called on the spot runs it, a static one through a namespace import too.
    expect(effectOf('listener', 'Invoked').usedIn).toEqual(['app/Providers/EdgeProvider.ts'])
    expect(effectOf('listener', 'NsStatic').usedIn).toEqual(['app/Providers/EdgeProvider.ts'])
    // A bound member handed to an on() whose event is a string is unconfirmed, as any handler there is.
    expect(effectOf('listener', 'StrBound')).toMatchObject({ usedIn: [], unprovenIn: ['app/Providers/EdgeProvider.ts'] })
    // once() and a class the framework exports register as on() and an app event class do.
    expect(effectOf('listener', 'AuthLogger').usedIn).toEqual([provider])
  })

  test('should not read a comment, a string, a type, a shadowing parameter or a registration as a use', () => {
    expect(effectOf('event', 'PostArchived')).toMatchObject({ usedIn: [], mentionedIn: [] })
    expect(effectOf('job', 'Reindex')).toMatchObject({ usedIn: [], mentionedIn: ['app/Providers/EventServiceProvider.ts'] })
    // A route handler (the third argument of a router's on()) is no registration this can confirm, and neither is a string event name.
    expect(effectOf('listener', 'Idle')).toMatchObject({ usedIn: [], unprovenIn: ['app/Services/Hooks.ts'], mentionedIn: [] })
    expect(effectOf('listener', 'ByName')).toMatchObject({ usedIn: [], unprovenIn: ['app/Services/Hooks.ts'], mentionedIn: [] })
    // Named in an on() handler, or called there only for a member every object has, and in its options.
    expect(effectOf('listener', 'OptionsOnly')).toMatchObject({ usedIn: [], unprovenIn: [], mentionedIn: ['app/Providers/EventServiceProvider.ts'] })
    // A member every object has, reached through a namespace import, and a member of a property only read the class.
    expect(effectOf('listener', 'NsTo')).toMatchObject({ usedIn: [], mentionedIn: ['app/Providers/EdgeProvider.ts'] })
    expect(effectOf('listener', 'NameRead')).toMatchObject({ usedIn: [], mentionedIn: ['app/Providers/EdgeProvider.ts'] })
    // A parameter default and a `var` of another class, a `var` loop head, and a cast assignment hold no instance.
    // A handler that only binds a member runs nothing of the listener.
    for (const className of ['ParamA', 'ParamB', 'VarLoop', 'WrappedL', 'Unrun']) {
      expect(effectOf('listener', className)).toMatchObject({ usedIn: [], mentionedIn: ['app/Providers/EdgeProvider.ts'] })
    }
    // An instance an on() handler refers to without calling anything on it.
    expect(effectOf('listener', 'Quiet')).toMatchObject({ usedIn: [], unprovenIn: [], mentionedIn: ['app/Providers/EventServiceProvider.ts'] })
    // Constructed and never sent, the second through a binding of the same name as a sent one.
    expect(effectOf('mail', 'DraftMail')).toMatchObject({ usedIn: [], mentionedIn: ['app/Http/Controllers/PostController.ts'] })
    // Also sent through a `var` initialised twice, and through a `let` reassigned, destructured into or looped over: none says which instance is sent.
    expect(effectOf('mail', 'ReceiptMail')).toMatchObject({ usedIn: [], mentionedIn: ['app/Services/Mailer.ts'] })
  })

  test('should not count a dispatch in the class’s own file or in a test', () => {
    expect(effectOf('job', 'Orphan')).toMatchObject({ usedIn: [], mentionedIn: [] })
  })

  test('should read a policy’s abilities off its class or its definePolicy object', () => {
    const abilitiesOf = (className: string) => detail.policies.find((entry) => entry.className === className)?.abilities

    expect(abilitiesOf('PostPolicy')).toEqual({ declared: ['view', 'update'], fields: ['delete', 'archive'] })
    expect(abilitiesOf('CommentPolicy')).toEqual({
      declared: ['view', 'update', 'publish'],
      fields: [],
      open: 'the definition spreads another object',
      exposes: DEFINE_POLICY_ABILITIES,
    })
    expect(abilitiesOf('TagPolicy')).toEqual({ declared: ['view'], fields: [], open: 'it extends BasePolicy, whose abilities are not read' })
    expect(abilitiesOf('LabelPolicy')).toEqual({ unreadable: 'the file declares no class LabelPolicy' })
  })

  test('should judge the scanned application end to end', () => {
    const judged = (document: PlanDraft) => judgePlan(document, app).elements.find((element) => element.id === 'fx' || element.id === 'pol')!

    expect(judged(effectPlan('listener', 'NotifyAuthor')).state).toBe('wired')
    expect(judged(effectPlan('job', 'Reindex')).notes).toEqual([
      "Not confirmed as wired: nothing in the application's source dispatches it (app/Providers/EventServiceProvider.ts names it without dispatching it).",
    ])
    expect(verdicts(judged(policyPlan([{ name: 'view', rule: 'anyone' }, { name: 'restore', rule: 'an admin' }])))).toEqual({
      'ability view': 'match',
      'ability view rule': 'unknown',
      'ability restore': 'differ',
      'ability restore rule': 'unknown',
    })
  })

  test('should leave a listener unproven, never absent, where AutoDiscovery finds listeners by directory', async () => {
    const discovering = await detailOf('discovery', {
      'app/Providers/DiscoveryProvider.ts': "import { AutoDiscovery } from '@guren/core'\n\nexport const discovery = new AutoDiscovery(process.cwd())\n",
    })

    expect(discovering.detail!.sideEffectUsesUnread).toEqual({ listener: expect.stringContaining('app/Providers/DiscoveryProvider.ts constructs AutoDiscovery') })
    expect(judgePlan(effectPlan('listener', 'Idle'), discovering).elements.find((element) => element.id === 'fx')!.notes[0]).toContain('AutoDiscovery')
  })

  test('should leave every use unproven while an application source file does not parse', async () => {
    const broken = await detailOf('broken', { 'app/Services/Broken.ts': 'export const = \n' })

    expect(broken.detail!.sideEffectUsesUnread?.job).toBe('app/Services/Broken.ts could not be parsed')
    expect(judgePlan(effectPlan('job', 'Reindex'), broken).elements.find((element) => element.id === 'fx')!.notes[0]).toContain('app/Services/Broken.ts could not be parsed')
  })
})

describe('DEFINE_POLICY_ABILITIES', () => {
  test('should be the methods the class definePolicy() returns declares', () => {
    const declared = Object.getOwnPropertyNames(definePolicy({}).prototype).filter((name) => name !== 'constructor')

    expect(declared.sort()).toEqual([...DEFINE_POLICY_ABILITIES].sort())
  })
})
