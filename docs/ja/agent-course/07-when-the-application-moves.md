# 第 7 章: アプリが動いたとき

計画は、特定のコミットの時点のアプリを前提に承認されます。しかし実際の開発はそこで止まらず、同僚がリファクタリングをマージして、計画が前提にしていた名前が消えることもあります。この章では参加登録の計画を実装しながら、途中でわざとそうした変更を起こします。そして、設計が合わなくなったまま作業を続けようとするエージェントを、Guren がどう止めるかを確認します。

**この章で学ぶこと:**

- 保留 (`held`) になったステップの意味と、エージェントだけでは解決できない理由
- 解決のための 2 つの選択肢 (変更を戻すか、計画を改訂するか)
- 計画の改訂が、検証済みのステップに与える影響
- 免除 (waiver) の役割

## 1. 実装を始める

Claude Code のセッションに、次のプロンプトを送ります。

```text
docs/plans/registrations/plan.json を plan-implement スキルで実装してください。1 ステップにつき 1 コミットです。
```

最初の 3 ステップは第 4 章と同じように進みます。中でも data ステップのコミットは丁寧に読んでください。第 6 章で `alter` として計画した `registrations` のリレーションが、このステップで `Meetup` に加わります。

**エージェントなしの場合:**

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
<summary>tests/plans/registrations/registrations.test.ts (セットアップ記入済み)</summary>

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
<summary>app/Models/Meetup.ts (registrations のリレーションを追加)</summary>

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

## 2. 同僚のコミット

エージェントが作業している間に、同僚が勉強会ページのルート名を `meetups.show` から `meetups.detail` に変えた、という想定です。同僚の役になって、次のコミットを作ってください。

```bash run
sed -i.bak "s/name: 'meetups.show'/name: 'meetups.detail'/" routes/meetups.ts
rm routes/meetups.ts.bak
bunx guren codegen
git add -A
git commit -m "refactor: rename the meetup page route"
```

アプリは問題なく動き、テストも通るので、何も壊れてはいません。ただし計画は `meetups.show` という名前でルートを指していて、`AC-registrations-7` もそのルートにリクエストを送ります。

## 3. ステップが held になる

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

第 3 章で説明した基準点 (baseline) の仕組みが、ここで働いています。Guren は承認時に、要素ごとにアプリ側の状態のハッシュを取っています。いま取り直すと、`route.meetups.show` のハッシュは承認時の状態とも、計画どおりに実装した後の状態とも一致しません。そのため、この要素に依存するステップは **保留** になり、そのステップを待つステップもすべて止まります。

エージェントにも同じ出力が届きます。ただし、どちらの直し方を選ぶかは設計上の判断なので、`plan-implement` スキルはエージェントに、自分で直さずに作業を止めて報告するよう指示しています。

| 選択肢 | 選ぶとき | すること |
|---|---|---|
| 変更を戻す | 同僚のコミットが間違っている | コミットを revert します。ステップの保留が解けます |
| 計画を改訂する | 変更は正しく、計画をそれに合わせるべき | アプリの現在の状態を指すように計画を直し、承認し直します |

今回の改名は妥当な変更なので、計画のほうを合わせます。

## 4. 改訂して承認し直す

Claude Code のセッションに、次のプロンプトを送ります。

```text
同僚がルート meetups.show を meetups.detail に改名しました。docs/plans/registrations/plan.json を plan:revise で改訂し、route.meetups.show が meetups.detail を名指すようにしてください。id はそのままにします。
```

計画のほかの部分や各種の記録はこの id で要素を指しているので、要素の id `route.meetups.show` は変えず、名前だけを変えます。

**エージェントなしの場合:**

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

基準点は第 6 章で記録したものから変わりません。承認し直すと新しいハッシュが記録されますが、計画を今日書いたものとして扱い直すわけではありません。

### verified 済みのステップ

検証の記録には、検証を実行したときの計画のハッシュが入っています。改訂でハッシュが変わったため、完了済みの 3 つのステップの記録は無効になりました。コードは変わっていないので、検証し直すだけで済みます。

```bash run fallback
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/scaffold
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/tests
bunx guren plan:verify docs/plans/registrations/plan.json --step task/entity/model.registration/data
```

エージェントに任せている場合は、作業の続きを指示すれば `plan-implement` スキルがこの再検証も行います。

## 5. 実装を終える

Claude Code のセッションに、次のプロンプトを送ります。

```text
docs/plans/registrations/plan.json の実装を続けてください。
```

第 6 章で読んだ Impact は、http ステップで役に立ちます。`MeetupResource` が登録数を必要とするようになり、この Resource は `index`、`show`、`edit` のすべてで組み立てられています。

**エージェントなしの場合:**

```bash run fallback
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:scaffold docs/plans/registrations/plan.json --step task/entity/model.registration/http --mount
```

<details>
<summary>RegistrationController、RegistrationPolicy、MeetupResource、MeetupController、勉強会のページ</summary>

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

最後のステップ `task/entity/model.meetup/http` は、承認時に警告が出た `alter`、つまり `MeetupController.show` のステップです。このステップではコードを追加せず、`AC-registrations-7` がこのアクションに到達することで確認が済みます。

http ステップのコミットは第 4 章のチェック表で確認し、この計画ではさらに次の 2 行を加えます。

| 確かめること | 理由 |
|---|---|
| `store` が登録を書く前に登録数を数えている | 「満席なら行を書かない」というルールを確かめるテストは、`AC-registrations-2` しかありません |
| `MeetupResource` を組み立てるアクションすべてが登録数を渡している | Impact に `index`、`show`、`edit` が挙がっていました |

## 6. クローズする

```bash run
bunx guren plan:next docs/plans/registrations/plan.json
bunx guren plan:close docs/plans/registrations/plan.json
git add -A
git commit -m "docs: close the registrations plan"
```

![「Bun night」の勉強会ページ。開始日時、「20 of 20 seats left」、赤い Register ボタン、Edit のリンクが並んでいます](../../images/agent-course-meetup-page.png)

`docs/entities/Registration.md` が新しく作られます。`docs/entities/Meetup.md` にはこの計画の履歴が 1 行追加され、1 本目の計画で書かれたブロックはそのまま残ります。

## 足りないまま受け入れるとき: waiver

計画では通知を送ることにしていたものの、リリースを来月に回すと決めた場合のように、要素をあえて仕上げないこともあります。そのままでは `plan:close` が拒否するので、計画を書き換えるのではなく、その判断を記録します。

```bash manual
bunx guren plan:waive docs/plans/<slug>/plan.json <element-id> --reason "Ships with the mail plan next month"
```

免除の記録は計画と同じディレクトリの `decisions.json` に書き込まれ、コミットされます。記録には計画のハッシュが入っているので、後の改訂版には引き継がれません。また `plan:close` は免除ごとに `make:adr` のコマンドを表示するので、判断はアーキテクチャの決定を記録する場所にも残ります。この講座では免除を使いませんでしたが、免除も承認と同じく人が下す判断です。

## ここまでの状態

- 参加登録を実装して検証を通し、計画をクローズしてドキュメントに残しました。
- 保留になったステップを計画の改訂で解決し、その理由は `revisions/0001.json` に残っています。

## よくあるつまずき

- **エージェントがルート名を元に戻して保留を「直す」。** これでは同僚の作業を断りなく取り消すことになります。どちらの選択肢を選んだかを、エージェントに伝えてください。
- **`.guren/*.gen.ts` が変わったので `plan:next` が拒否する。** codegen を実行しないままルートを変更したコミットがあります。`bunx guren codegen` を実行し、生成ファイルをコミットしてください。

## 演習

1. ブランチを切って、計画を改訂する代わりに同僚のコミットを revert し、`plan:next` を実行してください。ステップはまだ保留のままですか。
2. `docs/plans/registrations/revisions/0001.json` を読んでください。1 年後にレビューする人が、計画が `meetups.detail` を指している理由を知りたいとき、どのフィールドを見ればよいでしょうか。

## 次へ

[第 8 章: CI の中の計画](./08-plans-in-ci.md) では、ここまで手で実行してきた検査を、プルリクエストのたびに実行するようにします。
