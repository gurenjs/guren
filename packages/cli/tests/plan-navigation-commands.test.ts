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
      // A plan route's id is written as its name; a label with a space is quoted for the shell.
      { id: 'nav.post', command: "bunx guren nav:add 'Post a job' --route jobs.create --auth required --can create:Job" },
      // nav:add imports a root model only, so a module's goes in by hand.
      {
        id: 'nav.invoices',
        command: 'bunx guren nav:add Invoices --route invoices.index',
        byHand: "Then add show.can ['viewAny', Invoice] (imported from modules/billing/app/Models/Invoice) to the entry it writes.",
      },
      { id: 'nav.admin', command: "bunx guren nav:add 'Admin'\\''s' --route admin.index", byHand: 'Then add show.where { admin: true } to the entry it writes.' },
      { id: 'nav.home', command: 'bunx guren nav:remove home' },
      { id: 'nav.dashboard', byHand: 'Edit the entry for dashboard: label "Overview", auth \'required\'.' },
    ])
  })

  test('should leave out what the file already shows, and name everything when it cannot be read', () => {
    expect(planNavigationWork(plan, ['nav.home', 'nav.dashboard'], [])).toEqual([])
    expect(planNavigationWork(plan, ['nav.home', 'nav.done'], { unreadable: 'config/navigation.ts spreads its entries' })).toEqual([
      { id: 'nav.home', command: 'bunx guren nav:remove home' },
      { id: 'nav.done', command: 'bunx guren nav:add Done --route done.index' },
    ])
  })

  test('should name only the elements of the step it is given', () => {
    expect(planNavigationWork(plan, ['nav.home'], FILE)).toEqual([{ id: 'nav.home', command: 'bunx guren nav:remove home' }])
  })
})
