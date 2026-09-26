# Chapter 7: When the Application Moves

A plan is approved against the app as it was at one commit. Real work does not stop at that commit: a teammate merges a refactor, and a name the plan relies on disappears. This chapter builds the registrations plan, lets that happen halfway through, and shows how Guren stops the agent instead of letting it build on a design that no longer fits.

**What you'll learn:**

- What a **held** step is, and why the agent cannot resolve one
- The two ways out: undo the change, or revise the plan
- What a revision does to the steps already verified
- What a waiver is for

## 1. Start the build

> Implement docs/plans/registrations/plan.json with the plan-implement skill. One commit per step.

The first three steps go as in chapter 4. The data step is the one to read closely: it is where `Meetup` gains its `registrations` relationship, the `alter` from chapter 6.

**Without an agent:**

```bash run fallback
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:scaffold docs/plans/registrations/plan.json --step task/entity/model.registration/scaffold
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/scaffold
git add -A
git commit -m "feat(registrations): scaffold [task/entity/model.registration/scaffold]"
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:scaffold docs/plans/registrations/plan.json --step task/entity/model.registration/tests
```

<details>
<summary>tests/plans/registrations/registrations.test.ts, with the setup written</summary>

```ts file=tests/plans/registrations/registrations.test.ts fallback
import { beforeEach, describe, expect, test } from 'bun:test'
import { TestApp } from '@guren/testing'
import { resetDatabase } from '../../../config/database.js'
import { Meetup, type MeetupRecord } from '../../../app/Models/Meetup.js'
import { Registration } from '../../../app/Models/Registration.js'
import { User, type UserRecord } from '../../../app/Models/User.js'

let booted: Promise<TestApp> | undefined

function ready(): Promise<TestApp> {
  booted ??= import('../../../src/app.js').then(({ default: app }) => TestApp.fromApp(app))
  return booted
}

async function client(actor?: object): Promise<TestApp> {
  const http = actor === undefined ? await ready() : (await ready()).actingAs(actor)
  return http.withCsrf()
}

let ada: UserRecord
let grace: UserRecord
let meetup: MeetupRecord

async function seats(capacity: number) {
  meetup = await Meetup.forceCreate({ title: 'Bun night', startsAt: '2026-10-20T19:00', capacity, organizerId: grace.id })
}

function register(user: UserRecord) {
  return Registration.forceCreate({ meetupId: meetup.id, userId: user.id })
}

function count() {
  return Registration.where({ meetupId: meetup.id }).count()
}

beforeEach(async () => {
  await ready()
  await resetDatabase()
  ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
  grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
})

describe('Registration', () => {
  test('[AC-registrations-1] A signed-in user can register for a meetup with seats left.', async () => {
    await seats(2)
    await (await client(ada)).post(`/meetups/${meetup.id}/registrations`).assertStatus(303)
    expect(await Registration.where({ meetupId: meetup.id, userId: ada.id }).first()).not.toBeNull()
  })

  test('[AC-registrations-2] Registering for a full meetup writes no row.', async () => {
    await seats(1)
    await register(grace)
    await (await client(ada)).post(`/meetups/${meetup.id}/registrations`).assertStatus(303)
    expect(await count()).toBe(1)
  })

  test('[AC-registrations-3] Registering twice writes no second row.', async () => {
    await seats(5)
    await register(ada)
    await (await client(ada)).post(`/meetups/${meetup.id}/registrations`).assertStatus(303)
    expect(await count()).toBe(1)
  })

  test('[AC-registrations-4] A guest cannot register.', async () => {
    await seats(2)
    await (await client()).post(`/meetups/${meetup.id}/registrations`).assertRedirect('/login')
  })

  test('[AC-registrations-5] A user cannot cancel someone else\'s registration.', async () => {
    await seats(2)
    const registration = await register(grace)
    await (await client(ada)).delete(`/registrations/${registration.id}`).assertStatus(403)
    expect(await count()).toBe(1)
  })

  test('[AC-registrations-6] A guest cannot cancel a registration.', async () => {
    await seats(2)
    const registration = await register(grace)
    await (await client()).delete(`/registrations/${registration.id}`).assertRedirect('/login')
  })

  test('[AC-registrations-8] A user can cancel their own registration.', async () => {
    await seats(2)
    const registration = await register(ada)
    await (await client(ada)).delete(`/registrations/${registration.id}`).assertStatus(303)
    expect(await count()).toBe(0)
  })

  test('[AC-registrations-7] The meetup page shows the seats left.', async () => {
    await seats(2)
    await register(grace)
    const response = await (await client()).get(`/meetups/${meetup.id}`).assertStatus(200)
    await response.assertBodyContains('"seatsLeft":1')
  })
})
```

</details>

```bash run fallback
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/tests
git add -A
git commit -m "test(registrations): acceptance tests [task/entity/model.registration/tests]"
bunx guren plan:next docs/plans/registrations/plan.json
```

<details>
<summary>app/Models/Meetup.ts, with the registrations relationship</summary>

```ts file=app/Models/Meetup.ts fallback
import { defineModel, type BelongsToRecord, type HasManyRecord } from '@guren/core'
import { meetups, registrations, users } from '../../db/schema.js'

export type MeetupRecord = typeof meetups.$inferSelect
export type NewMeetupRecord = typeof meetups.$inferInsert
type UserRecord = typeof users.$inferSelect
type RegistrationRecord = typeof registrations.$inferSelect

export class Meetup extends defineModel(meetups, {
  fillable: ['title', 'startsAt', 'capacity'],
}) {
  static override relationTypes: {
    organizer: BelongsToRecord<UserRecord>
    registrations: HasManyRecord<RegistrationRecord>
  } = {
    organizer: null,
    registrations: [],
  }
}

Meetup.belongsTo('organizer', () => import('./User.js').then((module) => module.User), 'organizerId', 'id')
Meetup.hasMany('registrations', () => import('./Registration.js').then((module) => module.Registration), 'meetupId', 'id')
```

</details>

```bash run fallback
bun run db:make create_registrations
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/data
git add -A
git commit -m "feat(registrations): migration [task/entity/model.registration/data]"
```

## 2. A teammate's commit

While the agent works, a teammate renames the meetup page's route from `meetups.show` to `meetups.detail`. Make that commit yourself, to play the teammate:

```bash run
sed -i.bak "s/name: 'meetups.show'/name: 'meetups.detail'/" routes/meetups.ts
rm routes/meetups.ts.bak
bunx guren codegen
git add -A
git commit -m "refactor: rename the meetup page route"
```

Nothing is broken. The app works and its tests pass. But the plan names `meetups.show`, and `AC-registrations-7` requests it.

## 3. The step is held

```bash run
bunx guren plan:next docs/plans/registrations/plan.json
```

```text
No step can be returned: every step left is held, or waits on one that is.

Held, since what they depend on changed after the plan was approved:
  task/entity/model.registration/http
    route.meetups.show (routes, existing), named by AC-registrations-7: …
      fail  The route name "meetups.show" was not found in this application, …
```

This is the baseline from chapter 3 at work. At approval Guren hashed what the app held for each element. Now it hashes again, and the hash for `route.meetups.show` matches neither the approved state nor the state the plan itself would produce. So the step that depends on it is **held**, and so is everything waiting on that step.

The agent gets the same output. The `plan-implement` skill tells it to stop and report, not to fix it, because either fix is a decision about the design:

| Option | When | What you do |
|---|---|---|
| Undo the change | the teammate's commit was the mistake | revert it, and the step is no longer held |
| Revise the plan | the change is right, and the plan should follow it | edit the plan to name what the app holds now, and approve again |

The rename is a reasonable change, so the plan follows it.

## 4. Revise and approve again

> A teammate renamed the route meetups.show to meetups.detail. Revise docs/plans/registrations/plan.json with plan:revise so route.meetups.show names meetups.detail, keeping its id.

The element keeps its id, `route.meetups.show`: ids are how everything else in the plan, and every record, refers to it. Only the name changes.

**Without an agent:**

```bash run fallback
bunx guren plan:revise docs/plans/registrations/plan.json --ops - <<'EOF'
{
  "ops": [
    {"op": "modify", "section": "routes", "id": "route.meetups.show", "element": {"change": {"kind": "existing"}, "method": "GET", "path": "/meetups/:id", "name": "meetups.detail", "action": "action.meetups.show", "middleware": [], "bind": [{"param": "id", "model": "model.meetup"}]}, "reason": "A teammate renamed the route to meetups.detail."}
  ]
}
EOF
```

```bash run
git add docs/plans
git commit -m "docs: follow the meetups.detail rename in the registrations plan"
bunx guren plan:approve docs/plans/registrations/plan.json
git add docs/plans
git commit -m "docs: approve the revised registrations plan"
```

The baseline stays the one stamped in chapter 6. Approving again records the new hash; it does not pretend the plan was written today.

### The verified steps

A verification record names the plan hash it ran against. The revision changed the hash, so the three steps already done have no standing record. The code did not change, so verify them again:

```bash run fallback
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/scaffold
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/tests
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/data
```

With an agent, `plan-implement` does this on its own when you tell it to continue.

## 5. Finish the build

> Continue implementing docs/plans/registrations/plan.json.

The http step is the one where Impact from chapter 6 pays off. `MeetupResource` now needs a registration count, and `index`, `show` and `edit` all build it.

**Without an agent:**

```bash run fallback
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:scaffold docs/plans/registrations/plan.json --step task/entity/model.registration/http --mount
```

<details>
<summary>RegistrationController, RegistrationPolicy, MeetupResource, MeetupController and the meetup page</summary>

```ts file=app/Http/Controllers/RegistrationController.ts fallback
import { Controller } from '@guren/core'
import { Meetup } from '../../Models/Meetup.js'
import { Registration } from '../../Models/Registration.js'
import type { UserRecord } from '../../Models/User.js'

export default class RegistrationController extends Controller {
  async store(): Promise<Response> {
    const meetup = this.model(Meetup)
    const user = await this.auth.userOrFail<UserRecord>()
    const already = await Registration.where({ meetupId: meetup.id, userId: user.id }).first()
    const taken = await Registration.where({ meetupId: meetup.id }).count()
    if (!already && taken < meetup.capacity) {
      await Registration.forceCreate({ meetupId: meetup.id, userId: user.id })
    }
    return this.redirect(`/meetups/${meetup.id}`)
  }

  async destroy(): Promise<Response> {
    const registration = this.model(Registration)
    await this.authorize('delete', [Registration, registration])
    await Registration.delete({ id: registration.id })
    return this.redirect(`/meetups/${registration.meetupId}`)
  }
}
```

```ts file=app/Policies/RegistrationPolicy.ts fallback
import { Policy, type AuthUser } from '@guren/core'
import type { RegistrationRecord } from '../Models/Registration.js'

export class RegistrationPolicy extends Policy {
  delete(user: AuthUser | null, registration: RegistrationRecord): boolean {
    return user !== null && user.id === registration.userId
  }
}
```

```ts file=app/Http/Resources/MeetupResource.ts fallback
import { Resource } from '@guren/core'
import type { MeetupRecord } from '../../Models/Meetup.js'

export interface MeetupResourceData extends Record<string, unknown> {
  id: number
  title: string
  startsAt: string
  capacity: number
  seatsLeft: number
}

export class MeetupResource extends Resource<MeetupRecord & { registrationsCount: number }, MeetupResourceData> {
  toArray(): MeetupResourceData {
    return {
      id: this.resource.id,
      title: this.resource.title,
      startsAt: this.resource.startsAt,
      capacity: this.resource.capacity,
      seatsLeft: this.resource.capacity - this.resource.registrationsCount,
    }
  }
}
```

```ts file=app/Http/Controllers/MeetupController.ts fallback
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { MeetupPayloadSchema } from '../Validators/MeetupValidator.js'
import { MeetupResource } from '../Resources/MeetupResource.js'
import { Meetup } from '../../Models/Meetup.js'
import { Registration } from '../../Models/Registration.js'
import type { UserRecord } from '../../Models/User.js'

async function withSeats(id: number) {
  const [meetup] = await Meetup.withCount('registrations', { id })
  return new MeetupResource(meetup!).toArray()
}

export default class MeetupController extends Controller {
  async index(): Promise<Response> {
    const meetups = await Meetup.withCount('registrations')
    meetups.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    return this.inertia(pages.meetups.Index, { meetups: meetups.map((meetup) => new MeetupResource(meetup).toArray()) })
  }

  async show(): Promise<Response> {
    const meetup = this.model(Meetup)
    const user = await this.auth.user<UserRecord | null>()
    const registration = user ? await Registration.where({ meetupId: meetup.id, userId: user.id }).first() : null
    return this.inertia(pages.meetups.Show, { meetup: await withSeats(meetup.id), registrationId: registration?.id ?? null })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.meetups.Create, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(MeetupPayloadSchema)
    const user = await this.auth.userOrFail<UserRecord>()
    const meetup = await Meetup.forceCreate({ ...data, organizerId: user.id })
    return this.redirect(`/meetups/${meetup.id}`)
  }

  async edit(): Promise<Response> {
    const meetup = this.model(Meetup)
    await this.authorize('update', [Meetup, meetup])
    return this.inertia(pages.meetups.Edit, { meetup: await withSeats(meetup.id) })
  }

  async update(): Promise<Response> {
    const meetup = this.model(Meetup)
    await this.authorize('update', [Meetup, meetup])
    const data = await this.validateBody(MeetupPayloadSchema)
    await Meetup.update({ id: meetup.id }, data)
    return this.redirect(`/meetups/${meetup.id}`)
  }
}
```

```tsx file=resources/js/pages/meetups/Show.tsx fallback
import { Head, Link, router } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import type { MeetupResourceData } from '@/app/Http/Resources/MeetupResource'

interface Props {
  meetup: MeetupResourceData
  registrationId: number | null
}

export default function Show({ meetup, registrationId }: Props) {
  return (
    <Layout>
      <Head title={meetup.title} />
      <h1 className="text-3xl font-bold text-g-heading">{meetup.title}</h1>
      <p className="mt-2 text-g-text-2">{`${meetup.startsAt} · ${meetup.seatsLeft} of ${meetup.capacity} seats left`}</p>
      <div className="mt-6 flex gap-4">
        {registrationId !== null ? (
          <button type="button" className="text-g-danger" onClick={() => router.delete(`/registrations/${registrationId}`)}>Cancel</button>
        ) : meetup.seatsLeft > 0 ? (
          <button type="button" className="rounded-g-ctl bg-g-accent px-4 py-2 font-bold text-white" onClick={() => router.post(`/meetups/${meetup.id}/registrations`)}>Register</button>
        ) : (
          <p className="text-g-text-2">The meetup is full.</p>
        )}
        <Link href={`/meetups/${meetup.id}/edit`} className="text-sm text-g-accent">Edit</Link>
      </div>
    </Layout>
  )
}
```

</details>

```bash run fallback
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/http
git add -A
git commit -m "feat(registrations): register and cancel [task/entity/model.registration/http]"
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/pages
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.meetup/http
```

The last step, `task/entity/model.meetup/http`, belongs to `MeetupController.show`, the `alter` the approval warned about. It adds no code of its own; `AC-registrations-7` reaching the action is what confirms it.

Check the http commit against chapter 4's list, plus two rows for this plan:

| Check | Why |
|---|---|
| `store` counts registrations before it writes one | "A full meetup writes no row" is a rule, and `AC-registrations-2` is its only check |
| Every action that builds `MeetupResource` passes a count | Impact listed `index`, `show` and `edit` |

## 6. Close

```bash run
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:close docs/plans/registrations/plan.json
git add -A
git commit -m "docs: close the registrations plan"
```

![The meetup page for "Bun night": the start time, "20 of 20 seats left", a red Register button and an Edit link](../../images/agent-course-meetup-page.png)

`docs/entities/Registration.md` is new. `docs/entities/Meetup.md` gains a history line for this plan, and its own blocks from the first plan stay as they were.

## When you accept less: waivers

Sometimes an element should not be finished: the plan promised a notification, and you decide it ships next month. `plan:close` would refuse, so you record that decision instead of editing the plan:

```bash manual
bunx guren plan:waive docs/plans/<slug>/plan.json <element-id> --reason "Ships with the mail plan next month"
```

The waiver goes to `decisions.json` beside the plan and is committed. It names the plan hash, so a later revision inherits none of them. `plan:close` then prints a `make:adr` command for each waiver, so the decision also lands where the architecture decisions live. You did not need one in this course; a waiver is a decision a person makes, like approval.

## Where you are

- Registrations built, verified, closed, and documented.
- A held step you resolved by revising the plan, with the reason on record in `revisions/0001.json`.

## Common trip-ups

- **The agent "fixes" a held step by renaming the route back.** That undoes a teammate's work without asking. Tell it which option you chose.
- **`plan:next` refuses because `.guren/*.gen.ts` changed.** A commit changed routes without running codegen. Run `bunx guren codegen` and commit the generated files.

## Exercises

1. On a branch, revert the teammate's commit instead of revising the plan, and run `plan:next`. Is the step still held?
2. Read `docs/plans/registrations/revisions/0001.json`. Which field would tell a reviewer, a year from now, why the plan names `meetups.detail`?

## Next

[Chapter 8: Plans in CI](./08-plans-in-ci.md) makes the checks you ran by hand run on every pull request.
