# 永続エージェント

永続エージェント(durable agent)は、アプリケーション自身がホストする長命でステートフルなプロセスです。そしてアプリケーションへは、ルートがすでに宣言しているエージェントツールを通してしか到達しません。

[エージェントインターフェース](./agent-interface.md)は、エージェントが呼び出せる面をアプリケーションに与えるものでした。このガイドはその反対側、つまりその面を呼び出す自前のエージェントをホストする話です。1時間ごとに起きるトリアージ、1週間かけて調査結果を積み上げるリサーチャー、破壊的な変更を提案してから人間の承認を数日待つ運用エージェント、といったものです。

## 永続エージェントとは何か

ジョブにも cron にもない性質が3つあります。

- **永続的な identity。** 会話・テナント・タスクごとに1つのインスタンスがあり、名前で addressable です。
- **永続的な state。** `this.state` と専用の SQLite データベースは、デプロイにもエビクション(inactive なインスタンスの破棄)にも耐えます。
- **インスタンス単位のスケジュール。** 定期的な sweep には cron、「1時間後にもう一度見る」には秒数の遅延指定を使います。どちらも Durable Object の alarm に支えられているため、Worker に1件のリクエストも届かないままエージェントが起きます。

一方でエージェントは**特権を持った内部実装ではありません**。エージェントがアプリケーションに到達する手段は `this.tools.call(name, args)` だけであり、どの呼び出しも他のエージェント面とまったく同じ invocation パイプラインを通ります。登録が宣言したスコープ、ルート自身の検証とポリシー、承認キュー、そして `surface: 'durable'` として記録される redact 済みの監査レコードです。エージェントはアプリケーションの消費者であって、MCP サーバーでもなければ、モデルへの2つ目の特権経路でもありません。自社製のエージェントは外部のエージェントより信頼を**下げる**べきものです。無人で動くのですから。

基盤は Cloudflare Workers であり、今のところ Cloudflare Workers だけです。永続的な identity・alarm・インスタンス組み込みの state をエッジで同時に提供するプラットフォームは現時点で1つしかなく、`@guren/plugin-agents` はそれらをまとめた [Cloudflare Agents SDK](https://www.npmjs.com/package/agents) の上に作られています。Durable Object の Bun 上でのエミュレーションは用意していません。偽物のランタイムは、ローカルでアプリが正直に返す 503 より価値がないからです。

## インストールと登録

```bash
bun add @guren/plugin-agents @guren/plugin-cloudflare
```

`bunx guren plugin <package>` でもインストールでき、プラグインが宣言する互換性レンジも検証されます。`@guren/plugin-agents` はレジストリを引数に取る `definePlugin()` ファクトリなので、どちらの方法でも登録は手動です([プラグイン](./plugins.md#プラグインのインストール)を参照)。

配置先は `devDependencies` ではなく `dependencies` でなければなりません。生成されたワーカーがこのパッケージを import し、wrangler はデプロイ時に本番インストールからその import を解決するためです。エージェントをホストしていながら開発用依存としてしか持たないアプリは、`guren cloudflare:build` が拒否します。

```ts
// src/app.ts
import { createApp, EncryptionServiceProvider, EventServiceProvider } from '@guren/core'
import { agentsPlugin } from '@guren/plugin-agents'
import agents from '@/config/agents'
import { registerWebRoutes } from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
  providers: [
    EventServiceProvider,
    EncryptionServiceProvider,
    agentsPlugin(agents),
  ],
})

export default app
```

`EventServiceProvider` は、そもそも監査イベントを届かせるために必要です([監査ログ](./agent-interface.md#監査ログ)を参照)。

`EncryptionServiceProvider` と `APP_KEY` は、**保留中承認の台帳(ledger)** を機能させるために必要です。人間の承認待ちで park された呼び出しは、あとで再実行するために引数をどこかに保持しなければなりません。承認キューは設計上、引数の復元可能なコピーを一切持たないため、保持できる根拠はアプリキーで暗号化された状態、つまり at rest で ciphertext であることに置かれています。encrypter が bind されていない場合、プラグインは boot 時に警告を出し、台帳なしで動きます。park された呼び出しは `requestId` とともにエージェントへ報告されますが、自動での再実行は行われません。要件はプロバイダーが登録されていて `APP_KEY` が設定されていることであって、`providers` 配列内の特定の位置に置くことではありません。

## スキャフォールド

```bash
bunx guren make:agent Triager
```

クラスと、新規アプリに欠けているものすべてを書き出します。エージェントクラスだけでは何も読み込まず、何の境界も持たず、デプロイビルドからも見つからず、どのアプリにも定義されていない型を参照するため、動きようがありません。

| ファイル | 内容 |
|---|---|
| `app/Agents/Triager.ts` | クラス本体: state の形、cron スケジュール、ツール呼び出し1つ |
| `config/agents.ts` | 登録エントリ。ファイルがなければ作成し、あればパッチします |
| `guren.arch.ts` | `app/Agents/**` から `app/Models/**`・`db/**`・`@guren/orm`・`@guren/plugin-agents/runtime` への import を禁じるルール |
| `config/env.ts` | クラスが import する `Env`: D1 バインディングと、エージェントの Durable Object namespace 用のコメントアウトされたスロット。なければ作成し、すでに `Env` を export していればそのままにします |
| `tsconfig.json` | `compilerOptions.types` に `@cloudflare/workers-types` を追記します。`Cloudflare.Env` と `DurableObject` はここから来ます |

既存ファイルはすべてその場でパッチされ、当てられなかったパッチは飛ばされるのではなく貼り付け用のテキストとともに報告されます。登録されているように見えて実際はされていないアプリが残るほうが、メッセージ1つより悪いからです。tsconfig のパッチにはそういうケースが2つあります。`types` 配列がないファイル(新しく作ると自動の `@types` 探索が切れるので `bun-types` も並べる必要があり、コマンドはそれを勝手に決めずに追加すべき行を表示します)と、コメントを含むファイル(strict JSON ではありません)です。

自分でやることが2つ残ります。どちらも最初の typecheck の前に知っておく価値があります。

- **`src/app.ts` には触れません。** 上記のとおり `agentsPlugin(agents)` は自分で `createApp({ providers })` に追加してください。
- **依存関係。** アプリに `@cloudflare/workers-types` がなければ `bun add -d @cloudflare/workers-types` を実行します。その場合はコマンドがそう伝えます。

`config/env.ts` が `wrangler types` による生成ではなく手書きなのは、この型を `tsc` と Bun のテスト実行の両方が読むためで、どちらも「先に wrangler を実行してあること」に依存できません。`@cloudflare/workers-types` が宣言するのは `Cloudflare.Env` であって素の `Env` ではないので、クラスはアプリ自身のものを import します。バインディングが増えたら広げてください。

```ts
// config/env.ts
export interface Env {
  /** D1 バインディング。ORM しか読まないので `unknown` */
  DB: unknown
  /** wrangler がこのクラスにバインドする Durable Object namespace。Bun では存在しない */
  TRIAGER?: {
    idFromName(name: string): unknown
    get(id: unknown): { sweep(): Promise<unknown> }
  }
}
```

## レジストリ

`config/agents.ts` は、どのクラスがエージェントで、どこにあり、何を呼んでよいかを述べる唯一のファイルです。

```ts
// config/agents.ts
import { defineAgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      scopes: ['tool:tickets.index', 'tool:tickets.close'],
      budget: { callsPerMinute: 30 },
    },
  },
})
```

**この文法が静的であるのは、好みではなく制約です。** `guren cloudflare:build` はこのファイルをソースとして読み、生成するワーカーへクラスごとの名前付き export を追記します。実行時のクラス値からはソースパスを復元できないため、`module` と `export` はリテラル文字列でなければなりません。`agents` の中のスプレッド、計算されたキー、再エクスポートされた config は、ビルド側に export すべきものを何も残さないまま、設定上は登録済みに読めてしまいます。`guren check` はそれぞれを理由つきで failure にします。

同じファイルが持つルールがあと3つあります。

- **エージェント名は `^[A-Za-z0-9_-]+$` です。** 名前は principal id `agent:<name>:<instance>` の片割れなので、コロンや空白が入ると別々のエージェントが同じ id を作れてしまい、一方に与えられた承認をもう一方が消費できてしまいます。
- **1クラスは1エージェントです。** 実行時レジストリも生成ワーカーも export 名をキーにしているため、同じ名前を2つの登録が主張すると、片方が到達不能になります。
- **`budget.callsPerMinute` は1以上の整数です。** メーターなしの登録は存在せず、`budget` を書かないエージェントは 60 になります。`Infinity` と `NaN` は拒否されます。どちらもエラーを出さずにメーターを無効化してしまうからです。

### スコープ

登録時のスコープは、[トークンとスコープ](./agent-interface.md#トークンとスコープ)にあるトークンのスコープより意図的に**狭く**なっています。受け付けるのは2つの形だけです。

| スコープ | 許可するもの |
|---|---|
| `tool:tickets.close` | そのツール1つだけ |
| `tools:read` | 解決後の `readOnlyHint` が true のすべてのツール |

`tools:*` と `tools:tickets.*` のような prefix 付与は、発行済みトークンでは正当ですが**登録では拒否されます**。`token:issue` が未マッチのスコープを拒否するのと同じ理由で、無人の principal がまだ存在しないツールへの同意を先取りしてはならないからです。`tools:read` は生成物に固定されず、読み込まれたルートグラフに対して展開されます。`guren check` を実行したときと、ランタイムが boot したときの両方です。そのため read-only でなくなったルートは、次の生成時ではなく次の起床時にエージェントの呼び出せる範囲を狭めます。展開結果は `bunx guren check --json` の `agentScopes` に出ます。

予算超過は `reason: 'rate-limit'` を持つ `denied` の結果として返ります。ウィンドウはメモリ上のインスタンスに置かれるため、エビクションでリセットされます。つまりこれはバースト用の下限であってグローバルなクォータではなく、本当のクォータが要るアプリは共有ストアと自前の[レートリミットミドルウェア](./rate-limiting.md)を用意することになります。

### 承認キューの置き場所

`config/agents.ts` は `approvals` キーも受け付けますが、キューのストアと通知はそちらではなく `agentsPlugin(...)` の呼び出しに置いてください。レジストリは静的な登録だけに保ちます。`guren check` はこのファイルをソースとして読み、`guren cloudflare:build` は Bun 上でこのファイルを評価するため、ここで import した Drizzle のストアや通知チャネルは、その両方が耐えなければならない依存になります。

```ts
// src/app.ts
import { AgentApprovalRequested } from '@guren/core'
import { agentsPlugin } from '@guren/plugin-agents'
import agents from '@/config/agents'

agentsPlugin({
  ...agents,
  approvals: {
    store: new DrizzleApprovalStore(db),
    notify: (request) => notifications.sendToMany(admins, new AgentApprovalRequested(request)),
    ttlMs: 60 * 60 * 1000,
  },
})
```

## エージェントを書く

`GurenAgent` は SDK の `Agent` を継承し、追加するものはただ1つ、`this.tools` です。state・`this.sql`・スケジュール・キュー・fiber・WebSocket はそのまま通り抜けます。

```ts
// app/Agents/Triager.ts
import { GurenAgent } from '@guren/plugin-agents/agent'

import type { Env } from '@/config/env'

interface TriagerState {
  lastRunAt: string | null
  declined: number[]
}

export class Triager extends GurenAgent<Env, TriagerState> {
  initialState: TriagerState = { lastRunAt: null, declined: [] }

  async onStart(): Promise<void> {
    // Recurring schedules are idempotent, so re-registering on every wake
    // leaves one row.
    await this.schedule('0 * * * *', 'sweep')
  }

  async sweep(): Promise<void> {
    const listed = await this.tools.call('tickets.index', { status: 'open' })
    if (listed.pending) return          // waiting on a human; nothing ran
    if (!listed.ok || listed.outcome.isError) return

    this.setState({ ...this.#current(), lastRunAt: new Date().toISOString() })

    // Delay form, in seconds.
    await this.schedule(3600, 'sweep')
  }

  #current(): TriagerState {
    return { ...this.initialState, ...this.state }
  }
}
```

### 4つの答えと、1つの落とし穴

```ts
const result = await this.tools.call('tickets.close', { id })
```

| バリアント | 意味 |
|---|---|
| `result.ok` | 呼び出しが**ディスパッチされた**。アプリケーションが返した内容は `result.outcome` にある |
| `result.pending` | `approval: 'required'` のツールが呼び出しを park した。`result.requestId` がそのリクエストを指す |
| `result.denied` | HTTP が発生する前にゲートが拒否した。`result.reason` は `'auth'`・`'scope'`・`'approval'`・`'rate-limit'` のいずれか |
| `result.failed` | ディスパッチ自体が throw した |

**`ok` は成功ではありません。** それが言っているのはリクエストがアプリケーションに届いたということだけで、アプリケーション自身の判定は `result.outcome.isError`、HTTP ステータスは `result.outcome.status` にあります。ポリシーによる 403 もスキーマによる 422 も、どちらも `ok` として届きます。各バリアントでは他の3つの判別子が「存在しない」と型宣言されているため、`if (result.pending) return` は型ガードなしで narrowing できます。

`this.tools.preflight(name, args)` は、実行の代わりに同じルートへ判定を求めます([`--preflight` と `guren.preflight`](./agent-interface.md#mcp-経由で呼び出しを予行演習する)が到達するのと同じ seam です)。スコープゲートは動き、予算も消費されます。承認ゲートはスキップされます。承認が必要なツールこそ予行演習の価値が最も高く、そして予行演習は何も実行しないからです。

### state に関する2つのルール

**エージェントは永続的な identity と永続的な state であって、永続的な JavaScript スタックではありません。** インスタンスは非活動が続くとエビクトされ、実行中のメソッドはそれを生き延びません。起床をまたいで残すべきものは `this.setState` か `this.sql` にチェックポイントし、スケジュールで再開します。ローカル変数・タイマー・実行中の fetch は失われます。後述の park 済み呼び出しの台帳が、1週間眠る `await` ではなく state とスケジュールで作られているのはこのためです。

**state の形は進化しますが、インスタンスは進化しません。** `initialState` が適用されるのは**新規の** Durable Object だけです。以前のデプロイで動いたインスタンスは、そのとき書かれた state の形を保ち続けるため、あとから追加したフィールドはそこで `undefined` になります。これは型エラーではなく、デプロイ後の最初の sweep で起きる `Cannot convert undefined or null to object` です。上の `#current()` のように、読むたびに既定値を state の下に敷いてください。

### principal

インスタンスはそれぞれ独自の principal を持ちます。`agent:<name>:<instance>` で、instance の部分は Durable Object 自身の名前です。ポリシーからは service principal として見えるので、1つの ability が運用者とエージェントを別種の呼び出し元として受け入れられますし、あるインスタンスに与えられた承認を別のインスタンスが消費することはできません。これを設置する seam はプロセス内にあり、ワイヤ上の表現を一切持ちません。そのため `requireAuthenticated()`・`Controller.auth`・`Gate` は満たしますが、発行済みの `ApiToken` を判定する bearer トークンのチェックは意図的に満たしません。アプリケーションが発行していない credential を作り出すことになるからです。

## 人間を挟む

`approval: 'required'` を宣言したルートは最初の呼び出しを拒否し、保留リクエストを作成し、承認者に通知し、エージェントに id を渡します([承認が必要なツール](./agent-interface.md#承認が必要なツール)に全体像があります)。永続エージェントが加えるのは、自分から戻ってくるという点です。

```ts
export class Ops extends GurenAgent<Env, OpsState> {
  async retire(id: number): Promise<void> {
    const result = await this.tools.call('posts.destroy', { id })
    if (result.pending) return   // parked; the retry is scheduled for you
  }

  async onToolApprovalSettled(event: AgentToolApprovalSettled): Promise<void> {
    if (event.status === 'approved') {
      // event.args is the call a human answered; event.result is the retry's answer.
    }
  }
}
```

### 台帳

その `return` の裏側で、`this.tools` は `{ requestId, tool, args }` を `guren_pending_tool_calls` に書き込みます。エージェント自身の Durable Object SQLite にある、フレームワーク所有のテーブルです。キューは設計上、redact された入力と復元不可能な fingerprint しか保存しないため、再実行の材料はエージェント側に置くしかありません。それを許容できるのは境界が引かれているからです。このテーブルはどの API も公開しないインスタンス専用のストレージで、行はアプリキーで at rest 暗号化され、各行は対応する承認が決着するか期限切れになった時点で削除されます。TTL はキューのものであり、エージェントが延長してよいものではありません。

起床のたびに、エージェントは park 済みの全行についてキューへ問い合わせます。パイプライン経由なので、その確認自体も監査されます。`approved` なら保存した引数で元の呼び出しを繰り返します。キューの consume-on-use と fingerprint の一致により、これは人間が与えたその承認だけを、ちょうど1回消費します。

バックオフは30秒から確認ごとに倍増し、下限は1秒、上限は最も早い行の期限と承認 TTL の2つで抑えられます。確認スケジュールは常にちょうど1つです。1回の起床で全行を問い合わせるため、周期は最も古い行の伸びきったバックオフを引き継ぐのではなく、最も新しい park 済み呼び出しに合わせる必要があるからです。メモリ上には何も保持しません。リクエストと承認の間にエビクションが起きても失われるものはなく、state もスケジュールもどちらも永続だからです。

### `onToolApprovalSettled`

オーバーライド可能で、既定では何もせず、すべての結末に対して呼ばれます。

| `status` | 何が起きたか |
|---|---|
| `approved` | 人間が承認した。`result` は再実行自身の答えで、それ自体が拒否であることもある |
| `rejected` | 人間が拒否した。何も呼ばれていない |
| `expired` | 回答されないまま期限切れになった |
| `unknown` | キューにこのリクエストの記録がもう残っていない |
| `unreadable` | 台帳の行を復号できなかった(アプリキーのローテーション)。引数は失われ、再実行できるものは何もない |

`args` は park された呼び出しの引数を運びます。欠けるのは `'unreadable'` のときだけです。キューは復元可能なコピーを持たないため、人間が**どの呼び出し**に答えたのかをアプリケーションが知る場所はここだけです。

`status` と `result` が分かれている理由になっているケースが1つあります。再実行は走ったものの行を消す前に sweep が中断された場合、次の sweep は承認がすでに消費済みであることを見つけ、`status: 'approved'` かつ **`result` なし**で決着させ、何も呼びません。ここで呼び出しを繰り返すと、未消費の承認が見つからず、新しいリクエストを起票し、人間をもう一度呼び出し、承認されればアクションを2回実行してしまいます。

sweep は throw しないように書かれています。SDK は失敗したスケジュールコールバックに 3 回の試行を与えたのちスケジュールを破棄するため、行が1つ壊れているだけで sweep 全体が再生され、生き残った行が起床の当てを失うからです。行は1つずつ独立に処理され、あなたのフックが throw すれば報告のうえ握り潰され、予算不足で拒否された再実行は行を残します。人間の承認を拒否に費やさないためです。

### ストアと運用者側は自分で書く

承認ストアに既定の実装はありません。監査 sink に既定がないのと同じ理由で、プロセスメモリに退化する実装は、次の isolate が見たこともないレコードに対して「承認済み」と答えてしまうからです。`AgentApprovalStore` を実装してください(4つのメソッドと2つの保証は[キューを設定する](./agent-interface.md#キューを設定する)にあります)。リクエストの解決は自前のルートで行います。[`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents) に Drizzle 実装と小さな運用 API があるので、そこから写せます。

その運用 API が教えてくれたことのうち、あなたの実装でも繰り返す価値のあるものが3つあります。

- **status は導出する。カラムを読まない。** ウィンドウが閉じたリクエストも SQL 上はまだ `pending` に見えます。回答可能な一覧からは落としてください。
- **二重回答には 409 を返す。** すでに誰かが解決したリクエストも、ウィンドウが閉じたリクエストも、今は回答できません。`404` は「その id のリクエストが存在しない」だけを意味すべきです。
- **保持期間はポリシーの問題。** 決着したリクエストは、エージェントが何を許されたかの記録です。古いものの削除は、勝手に判断するスケジュールではなく運用者が叩くルートに値します。

永続エージェント自身の status 確認は、MCP クライアントに対する `guren.approval_status` とまったく同じ答えを、同じルールで、同じツール名の下に監査されながら受け取ります。区別を拒む部分も含めてです。未知の id と他の principal の id は1つの同じメッセージになるため、どちらの面も同僚が何の承認を待っているかの列挙には使えません。

## Workers へのデプロイ

エージェントは通常の Cloudflare ビルドに乗ります。残りの経路(D1・セッション・静的アセット・シークレット)は [Cloudflare Workers デプロイ](./cloudflare.md)にあります。

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

アプリに `config/agents.ts` があると、ビルドはワーカーの Durable Object 側の半分を追加します。

```js
// .cloudflare/worker.js — generated
const handler = createWorkersHandler(app)
configureAgentRuntime((env) => handler.boot(env))

export { Triager } from '../app/Agents/Triager.ts'

const agentBindings = ["TRIAGER"]

const agentEntry = {
  async fetch(request, env, ctx) {
    await handler.boot(env)
    const routed = await routeGuardedAgentRequest(request, env, agentsConfig.routing, agentBindings)
    if (routed) return routed
    return handler.fetch(request, env, ctx)
  },
}
```

登録済みクラスごとの名前付き export があるので、wrangler は Durable Object バインディングの向け先を得られます。boot のスロットは両方のエントリポイントで1つです。どのリクエストもアプリを boot していない段階で alarm がエージェントを起こすことがあるためで、その場合はエージェントが boot し、あとから来たリクエストは2つ目を始めずにその boot に合流します。そしてバインディングの一覧が明示されているのは、そうしないと SDK のルーターが `env` 内のすべての Durable Object に到達してしまうからです。

### バインディング検証

ビルドはコミット済みの `wrangler.jsonc` を読み、登録済みクラスに SQLite バックの Durable Object バインディングがない場合は続行を拒否します。しかもアプリのビルドが走る前、Vite の出力を数分眺めたあとではなく最初にです。これらのエントリを手書きしないでください。ビルドを実行し、印字された JSON を貼り付けます。

背景として3点あります。

- **wrangler の2つの形式をどちらも受け付けます。** レガシーな `migrations[].new_sqlite_classes` のリストと、宣言的な `exports` マップ(`{ "type": "durable-object", "storage": "sqlite" }`)です。wrangler はこの2つを排他として扱うので、どちらか一方を使ってください。新規スキャフォールドは migrations 形式になります。Agents SDK がドキュメント化しているのがそちらだからです。
- **名前付き環境はそれぞれ個別に検証されます。** `durable_objects` は `env.<name>` ブロックに継承されないため、トップレベルではクラスをホストしていて実際にデプロイする環境ではしていない、という設定はここで捕まります。
- **`"minify": true` は拒否されます。** wrangler の minifier は識別子をリネームしますが、エージェントクラスは実行時に自分の名前で探されます。マングルされると、問題なく見えたデプロイのあとで全ツール呼び出しが "is not registered" で失敗します。

### インスタンスに誰が到達してよいか

エージェントを登録すると、生成されたワーカーは `/agents/` プレフィックス全体を SDK のルーターのために予約し、そこは**すべて拒否**になります。その下のあらゆるリクエストとあらゆる WebSocket アップグレードは、あなたが許可を宣言するまで 403 で拒否されます。拒否は Durable Object が構築される前に起きるため、認可されない呼び出し元はコールドスタートの費用すら発生させません。

```ts
// config/agents.ts
export default defineAgentsConfig({
  agents: { /* … */ },
  routing: {
    authorize(request, target) {
      // target.agent is the Durable Object *binding* name the SDK resolved the
      // URL segment to (the path carries it kebab-cased), not the key above.
      return ownsInstance(request, target.instance)
    },
  },
})
```

通すなら `true`、403 なら `false`、自分で応答するなら `Response` を返します。`routeAgentRequest` はルーターであって認証層ではありません。この関数がその層です。あるべき形が固まるまでの間、ポリシーの語彙ではなく意図的に述語1つになっています。

**自前の運用ルートは `/agents/` プレフィックスの外に置いてください。** その下に登録したルートは、拒否される以前に到達不能になります。`examples/agents` は `/ops/agents/…` という綴りを使っています。

### エージェントと話す

アプリケーションが自分のエージェントと話すときは、HTTP ではなくバインディング経由です。

```ts
// app/Http/Controllers/AgentOpsController.ts
import { Controller } from '@guren/core'
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

import type { Env } from '@/config/env'

export default class AgentOpsController extends Controller {
  async sweep(): Promise<Response> {
    if (!isWorkersRuntime()) {
      return this.json({ error: 'Agents run on Workers. Start this app with `wrangler dev --local`.' }, { status: 503 })
    }
    const namespace = getWorkersEnv<Env>().TRIAGER
    if (!namespace) return this.json({ error: 'No Triager binding.' }, { status: 503 })

    const stub = namespace.get(namespace.idFromName('main'))
    return this.json({ swept: await stub.sweep() })
  }
}
```

エージェントクラスの public メソッドはすべて stub 経由で呼べます。`bun run dev` には Durable Object 名前空間が存在しないため、503 を返すのが正直な応答です。アプリのエージェント側は `wrangler dev --local` と本番で動きます。

### シークレットとデータベース

```bash
bunx wrangler secret put APP_KEY
```

台帳はこの鍵で暗号化されます。鍵がなければ `agentsPlugin` は boot 時に警告し、再実行を一切行いません。`.dev.vars` は決してコミットしないでください。

承認ストアはただのテーブルなので、スキーマの他の部分と同じく D1 に置きます。マイグレーションで作成し、`wrangler d1 migrations apply` で帯域外に適用します。Workers 上でアプリが自分をマイグレートすることはありません。

### 無料プラン

リファレンスアプリは Workers の**無料**プランのアカウントにデプロイされ、`wrangler tail` で計測されました([README に表があります](https://github.com/gurenjs/guren/tree/main/examples/agents))。呼び出しが park してから30秒後、Worker に1件のリクエストも届かないまま alarm が発火し、再実行がチケットをクローズしました。プランに何が収まるかを枠づける数字が3つあります。startup が約 100 ms、Durable Object の sweep 全体(boot + ツール呼び出し2回 + 承認レコード2件)が 47 ms の CPU、台帳の alarm が 14 ms です。

見込んでおく価値のある上限が2つあります。

**Worker の1呼び出しあたり CPU 10 ms。** ウォームなリクエストは 4 ms でした。コールドな isolate でアプリケーションを boot するリクエストは 20〜30 ms を計測し、それでも `outcome: ok` を返しています。Cloudflare がこの上限を厳格な打ち切りではなく許容つきで運用しているためです。とはいえ上限を超え続ける Worker はエラー 1102 で失敗し始めることがあります。Durable Object ははるかに大きな独自の予算を持つので、露出しているのはエージェントの作業ではなく運用 API のコールドブートのほうです。`bunx wrangler tail` の `cpuTime` を見てください。1102 が出るようなら、有料プランで上限は外れます。

**Worker の1呼び出しあたり D1 クエリ 50 件**(有料プランは 1,000 件)。そして sweep 全体が1回の Durable Object 呼び出しの中で走ります。したがって1回の sweep が新規に問い合わせる件数に上限を設け、残りは次回に繰り越すものとして報告します。

```ts
const MAX_ASKS_PER_SWEEP = 10
```

算数は自分のツールに対してやり直してください。リファレンスアプリでは index の呼び出しが1クエリ、新規の承認1件ごとに `findMatch` と `create` で2クエリなので、sweep 全体は 1 + 2 × 10 = 21 に収まります。同じ上限は毎分の予算にも効きます。これがないと、たまった処理が最初の数件でウィンドウを使い切り、後ろの全部を飢えさせます。すでに park 済みの項目を覚えておくことも忘れないでください。さもないと毎回の sweep が同じ質問を繰り返します。

**日次**の割り当ては別の天井で、通常はここが制約になりません。1時間ごとの sweep と数件の保留承認なら、1日あたり数十回の起床です。

## テスト

ランタイムが分かれているとおりに、テストも分けます。

**エージェントのロジックは Bun で。** エージェントが `this.tools` を通して行うことはすべて[ツールをテストする](./agent-interface.md#ツールをテストする)のディスパッチ契約なので、workerd なしで `TestApp` に対して駆動できます。純粋な判断の部分(どれが古いか、どれを問い合わせるか、上限で何件許すか)は独立したモジュールに切り出して直接テストしてください。Durable Object は Bun で動かせず、その算数は動かせるべきだからです。

**Durable Object の挙動は workerd で。** alarm からの boot、名前付き export、ルーティングのガード、エビクション後の承認再実行は、まさにモックでは動かせない部分です。[`@cloudflare/vitest-plugin`](https://www.npmjs.com/package/@cloudflare/vitest-plugin) の下で、代替物ではなく**生成された**ワーカーに対して実行してください。そうすればビルドの配線そのものがテスト対象になります。このパッケージは `evictDurableObject` を提供しているので、「再実行はエビクションを生き延びる」は主張ではなく本物のアサーションになります。

このリポジトリの2つのスイートがその2つの形です。workerd レーンが `packages/plugin-agents/tests/workers`、アプリケーション自身のものが `examples/agents/tests` です。

## チェックが守るもの

`bunx guren check` は `config/agents.ts` があればエージェントレジストリを自動的に拾い、なければ何も report しません。

`check` が **failure** とするのは、check 自身またはデプロイビルドが読めないレジストリです。パースできないファイル、リテラルな `defineAgentsConfig({ agents: { … } })` になっていない config、`agents` 内のスプレッド、リテラルでない `module` や `export`、存在しないファイルを指す `module` やそのクラスをクラス宣言として export していないモジュール、重複したエージェントキーや export 名、欠けている・リテラルでない `scopes` 配列、登録文法から外れたスコープです。どのルートも宣言していないツールを指す `tool:` スコープには **warn** します。ゲートは fail-closed なのでそのスコープは何も許可しません。穴ではなく、タイポかリネームされたルートです。

レジストリのルールのうち2つは別の場所で強制されるので、どこで落ちるかを知っておく価値があります。`^[A-Za-z0-9_-]+$` から外れたエージェント名と、1以上の整数でない `budget.callsPerMinute` は、`check` ではなく `agentsPlugin` が boot 時に拒否します。レビューではなくアプリの起動が失敗します。

`bunx guren check --arch` は、スキャフォールドが書いた境界を強制します。`app/Agents/**` のファイルが `app/Models/**`・`db/**`・`@guren/orm`・`@guren/plugin-agents/runtime` を import していれば failure です。はっきり言っておくと、**これはサンドボックスではなく規律です。** プロセス内のアプリケーションコードは isolate を共有していて何でも import できますし、チェッカーが見るのは静的な import だけで、動的な `import()` はすり抜けます。この境界が買っているのは、越境が偶発ではなくレビューで見えるということであり、もう半分は監査ログです。

エージェントが呼ぶルートは通常のエージェントルールでチェックされます。ここで最も重要なのは、read-only でないツールには認証だけでなく**認可**が必要だという点です。[認証は認可ではありません](./agent-interface.md#認証は認可ではありません)を参照してください。

## 関連

- [エージェントインターフェース](./agent-interface.md): `.agent()` ルート、ツールの導出、スコープ、承認、そしてエージェントの呼び出しが載る監査ログ
- [Cloudflare Workers デプロイ](./cloudflare.md): 残りのデプロイ経路(D1・セッション・シークレット・静的アセット)
- [認可](./authorization.md): `agent:<name>:<instance>` principal が何をしてよいかを決めるポリシー
- [暗号化](./encryption.md): `APP_KEY` と、台帳が必要とする encrypter
- [CLI](./cli.md): `make:agent`・`check`・`audit`・`tool:list`
- [RFC 0017: Durable Agent Runtime](https://github.com/gurenjs/guren/blob/main/rfcs/0017-durable-agent-runtime.md): 設計と、実装が設計から外れたすべての箇所
- [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents): 動くトリアージャ、その承認ストア、運用 API、そして無料プランでの実測値
