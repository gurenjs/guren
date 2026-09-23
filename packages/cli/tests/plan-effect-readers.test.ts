import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { PlanAppDetail, PlanAppPolicyDetail, PlanAppSideEffectDetail } from '../src/plan/app-detail'
import { loadPlanAppState, type PlanAppState } from '../src/plan/app-state'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import type { PlanStepRecord } from '../src/plan/state'
import { judgePlan, type PlanElementStatus } from '../src/plan/status'
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

function effect(className: string, file: string, uses: Partial<Pick<PlanAppSideEffectDetail, 'usedIn' | 'mentionedIn'>> = {}): PlanAppSideEffectDetail {
  return { className, module: null, file, usedIn: [], mentionedIn: [], ...uses }
}

function only(document: PlanDraft, app: PlanAppState, id: string): PlanElementStatus {
  const element = judgePlan(document, app).elements.find((candidate) => candidate.id === id)
  if (!element) throw new Error(`no element ${id}`)
  return element
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

  test('should call a policy whose class could not be resolved unjudged, with every ability unknown', () => {
    const element = only(policyPlan([{ name: 'delete', rule: 'r' }]), state({ policies: [policy({ unreadable: 'the file declares no class PostPolicy' })] }), 'pol')

    expect(element.properties[0]).toMatchObject({ verdict: 'unknown', reason: expect.stringContaining('declares no class PostPolicy') })
    expect(element.state).toBe('unjudged')
  })
})

describe('judgePlan on side effects', () => {
  const posted = (uses: Partial<Pick<PlanAppSideEffectDetail, 'usedIn' | 'mentionedIn'>>) =>
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

  test('should not call a side effect wired when a source file the scan needed did not parse', () => {
    const app = state({
      sideEffects: { ...NO_SIDE_EFFECTS, job: [effect('SendDigest', 'app/Jobs/SendDigest.ts')] },
      sideEffectUsesUnread: 'app/Broken.ts could not be parsed',
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
    const document = effectPlan('job', 'SendDigest')
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
      fingerprint: { files: { 'app/Jobs/SendDigest.ts': 'h' }, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
    }
    const records = Object.fromEntries(listPlanSteps(derivation).map(({ step }) => [step.id, record]))
    const judged = (usedIn: string[]) =>
      judgePlan(document, state({ sideEffects: { ...NO_SIDE_EFFECTS, job: [effect('SendDigest', 'app/Jobs/SendDigest.ts', { usedIn })] } }))
    const lift = (usedIn: string[]) =>
      applyVerification(judged(usedIn), derivation, records, 'digest', new Map([['app/Jobs/SendDigest.ts', 'h']]), document).status.elements.find((element) => element.id === 'fx')!

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
  'app/Mail/WelcomeMail.ts': "import { Mail } from '@guren/core'\n\nexport class WelcomeMail extends Mail {}\n",
  'app/Mail/DraftMail.ts': "import { Mail } from '@guren/core'\n\nexport class DraftMail extends Mail {}\n",
  'app/Mail/ResetMail.ts': "export async function sendResetMail(to: string): Promise<void> {\n  void to\n}\n",
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
  'app/Providers/EventServiceProvider.ts': `import { ServiceProvider, registerJob, type EventManager } from '@guren/core'
import { PostPublished } from '../Events/PostPublished.js'
import { LogPost } from '../Listeners/LogPost.js'
import { NotifyAuthor } from '../Listeners/NotifyAuthor.js'
import { Idle } from '../Listeners/Idle.js'
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
    const idle: Idle | null = null
    void idle
  }
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
  })

  test('should not read a comment, a string, a type, a shadowing parameter or a registration as a use', () => {
    expect(effectOf('event', 'PostArchived')).toMatchObject({ usedIn: [], mentionedIn: [] })
    expect(effectOf('job', 'Reindex')).toMatchObject({ usedIn: [], mentionedIn: ['app/Providers/EventServiceProvider.ts'] })
    expect(effectOf('listener', 'Idle')).toMatchObject({ usedIn: [], mentionedIn: [] })
    // Constructed and never sent.
    expect(effectOf('mail', 'DraftMail')).toMatchObject({ usedIn: [], mentionedIn: ['app/Http/Controllers/PostController.ts'] })
  })

  test('should not count a dispatch in the class’s own file or in a test', () => {
    expect(effectOf('job', 'Orphan')).toMatchObject({ usedIn: [], mentionedIn: [] })
  })

  test('should read a policy’s abilities off its class or its definePolicy object', () => {
    const abilitiesOf = (className: string) => detail.policies.find((entry) => entry.className === className)?.abilities

    expect(abilitiesOf('PostPolicy')).toEqual({ declared: ['view', 'update'], fields: ['delete'] })
    expect(abilitiesOf('CommentPolicy')).toEqual({ declared: ['view', 'update'], fields: [], open: 'the definition spreads another object' })
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

  test('should leave every use unproven while an application source file does not parse', async () => {
    const broken = await detailOf('broken', { 'app/Services/Broken.ts': 'export const = \n' })

    expect(broken.detail!.sideEffectUsesUnread).toBe('app/Services/Broken.ts could not be parsed')
    expect(judgePlan(effectPlan('job', 'Reindex'), broken).elements.find((element) => element.id === 'fx')!.notes[0]).toContain('app/Services/Broken.ts could not be parsed')
  })
})
