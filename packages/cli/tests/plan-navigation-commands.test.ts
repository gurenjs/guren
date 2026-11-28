import { describe, expect, test } from 'bun:test'

import { planNavigationWork } from '../src/plan/navigation-commands'
import { PlanDraftSchema } from '../src/plan/schema'

const existing = { kind: 'existing' as const }
const plan = PlanDraftSchema.parse({
  planVersion: 2,
  title: 'Jobs',
  summary: 'Link the jobs.',
  scope: { goals: [], nonGoals: [] },
  locale: 'en',
  models: [
    { id: 'model.job', change: existing, name: 'Job', table: 'jobs', columns: [], relationships: [], fillable: [] },
    { id: 'model.invoice', change: existing, name: 'Invoice', module: 'billing', table: 'invoices', columns: [], relationships: [], fillable: [] },
  ],
  policies: [
    { id: 'policy.job', change: existing, name: 'JobPolicy', model: 'model.job', abilities: [{ name: 'create', rule: 'Signed in.' }] },
    { id: 'policy.invoice', change: existing, name: 'InvoicePolicy', module: 'billing', model: 'model.invoice', abilities: [{ name: 'viewAny', rule: 'Signed in.' }] },
  ],
  routes: [{ id: 'route.jobs.create', change: existing, method: 'GET', path: '/jobs/create', name: 'jobs.create', action: 'action.jobs.create', middleware: [], bind: [] }],
  navigation: [
    { id: 'nav.post', change: { kind: 'add' }, route: 'route.jobs.create', label: 'Post a job', auth: 'required', can: { ability: 'create', policy: 'policy.job' } },
    { id: 'nav.invoices', change: { kind: 'add' }, route: 'invoices.index', label: 'Invoices', can: { ability: 'viewAny', policy: 'policy.invoice' } },
    { id: 'nav.admin', change: { kind: 'add' }, route: 'admin.index', label: "Admin's", where: [{ field: 'admin', value: true }] },
    { id: 'nav.home', change: { kind: 'drop', reason: 'The brand links home.' }, route: 'home' },
    { id: 'nav.dashboard', change: { kind: 'alter' }, route: 'dashboard', label: 'Overview', auth: 'required' },
    { id: 'nav.done', change: { kind: 'add' }, route: 'done.index', label: 'Done' },
  ],
})
const ALL = (plan.navigation ?? []).map((entry) => entry.id)
const FILE = [
  { route: 'home', label: 'Home', line: 7 },
  { route: 'dashboard', label: 'Dashboard', line: 8 },
  { route: 'done.index', label: 'Done', line: 9 },
]

describe('planNavigationWork (RFC 0040 §5)', () => {
  test('should name nav:add and nav:remove by the route name, and what the commands cannot say by hand', () => {
    expect(planNavigationWork(plan, ALL, FILE)).toEqual([
      // A plan route's id is written as its name; flag values are attached, and a label with a space is quoted.
      { id: 'nav.post', command: "bunx guren nav:add --route=jobs.create --auth=required --can=create:Job 'Post a job'" },
      // nav:add imports a root model only, so a module's goes in by hand.
      {
        id: 'nav.invoices',
        command: 'bunx guren nav:add --route=invoices.index Invoices',
        byHand: 'Then add show.can ["viewAny", Invoice] (imported from modules/billing/app/Models/Invoice) to the entry it writes.',
      },
      { id: 'nav.admin', command: "bunx guren nav:add --route=admin.index 'Admin'\\''s'", byHand: 'Then add show.where { admin: true } to the entry it writes.' },
      { id: 'nav.home', command: 'bunx guren nav:remove home' },
      { id: 'nav.dashboard', byHand: 'Edit the entry for dashboard: label "Overview", show.auth "required".' },
    ])
  })

  test('should leave out what the file already shows, and tell an entry that is there but shows otherwise', () => {
    // The home entry is gone and the dashboard entry shows what the alter states.
    expect(planNavigationWork(plan, ['nav.home', 'nav.dashboard'], [{ route: 'dashboard', label: 'Overview', auth: 'required', line: 7 }])).toEqual([])
    // nav:add ran and the where was not added yet: the entry is there, short of its audience.
    expect(planNavigationWork(plan, ['nav.admin'], [{ route: 'admin.index', label: "Admin's", line: 7 }])).toEqual([
      { id: 'nav.admin', byHand: 'The entry for admin.index is there and shows otherwise; edit it to show.where { admin: true }.' },
    ])
    expect(planNavigationWork(plan, ['nav.dashboard'], [])).toEqual([
      { id: 'nav.dashboard', byHand: 'dashboard has no entry in config/navigation.ts to alter: plan:status reports it.' },
    ])
  })

  test('should keep a value opening with a dash from reading as a flag, and run in the app the plan is for', () => {
    const dashed = PlanDraftSchema.parse({ ...plan, navigation: [{ id: 'nav.dash', change: { kind: 'add' }, route: '-dash', label: '-Dash' }] })
    expect(planNavigationWork(dashed, ['nav.dash'], [], { cd: 'cd apps/shop && ' })).toEqual([
      { id: 'nav.dash', command: 'cd apps/shop && bunx guren nav:add --route=-dash -- -Dash' },
    ])
  })

  test('should name only the elements of the step it is given', () => {
    expect(planNavigationWork(plan, ['nav.home'], FILE)).toEqual([{ id: 'nav.home', command: 'bunx guren nav:remove home' }])
  })
})
