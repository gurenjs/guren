# 永続エージェント

永続エージェント(durable agent)は、アプリケーションが自分でホストする、長く動き続けて状態を持つプロセスです。アプリケーションには、ルートがすでに宣言しているエージェントツールを通してしかアクセスしません。

[エージェントインターフェース](./agent-interface.md)では、エージェントが呼び出せる窓口をアプリケーションに用意しました。このガイドではその反対側、つまりその窓口を呼び出すエージェントを自分でホストする方法を扱います。1 時間ごとに起きてトリアージを行うエージェント、1 週間かけて調査結果を積み上げていくエージェント、破壊的な変更を提案したあと人の承認を何日でも待つ運用エージェントなどがその例です。

エージェントを動かすまでの手順は次のとおりで、それぞれ下の節で説明します。

1. [パッケージをインストールする](#インストールと登録)
2. `make:agent` で[クラスの雛形を作る](#スキャフォールド)。`config/agents.ts` の登録もこのとき書き出されます
3. `src/app.ts` に [`agentsPlugin(agents)` を追加する](#インストールと登録)
4. 呼び出せるツールや予算など、[レジストリの登録内容を調整する](#レジストリ)
5. `this.tools` を使って[エージェントを書く](#エージェントを書く)
6. [Workers にデプロイする](#workers-へのデプロイ)

人の承認を待つ呼び出しは[人間を挟む](#人間を挟む)で、テストの分け方は[テスト](#テスト)で扱います。

## 永続エージェントとは何か

永続エージェントには、ジョブにも cron にもない性質が 3 つあります。

- **永続的な ID。** 会話、テナント、タスクごとにインスタンスが 1 つあり、名前を指定して呼び出せます。
- **永続的な状態。** `this.state` と専用の SQLite データベースは、デプロイをまたいでも、エビクション(非アクティブなインスタンスの破棄)が起きても残ります。
- **インスタンスごとのスケジュール。** 定期的な処理(sweep)には cron を、「1 時間後にもう一度見る」ような処理には秒数での遅延を使います。どちらも Durable Object の alarm で動くので、Worker にリクエストが 1 件も届かなくてもエージェントは起きます。

インスタンスはそれぞれ Cloudflare の *Durable Object* です。Durable Object は名前で呼び出せる専用のストレージ付きのインスタンスで、使われていない間は Cloudflare がエビクション（破棄）し、名前やアラームでまた起こします。

エージェントは、アプリに特別な権限で入れるわけではありません。入り口は `this.tools.call(name, args)` だけで、どの呼び出しも、ほかのエージェントからの呼び出しと同じ検査を通ります。

- 登録時に宣言したスコープ
- ルート自身の検証とポリシー
- 承認が必要なツールなら、承認キュー
- 秘密の値を伏せた監査レコード（`surface: 'durable'`）

自社で作ったエージェントは、人が見ていないところで動くので、外部のエージェントよりも**低い**信頼で扱ってください。

永続エージェントは Cloudflare Workers でだけ動きます。永続的な ID、アラーム、インスタンスごとの状態をエッジでまとめて提供しているプラットフォームは今のところ Cloudflare Workers だけで、`@guren/plugin-agents` はそれらをまとめた [Cloudflare Agents SDK](https://www.npmjs.com/package/agents) の上に作られています。

Bun では Durable Object を再現しないので、ローカルでは、エージェントと話すアプリのルートが 503 を返します（[エージェントと話す](#エージェントと話す)を参照）。見せかけの実装より、そのほうが正直です。

## インストールと登録

```bash
bun add @guren/plugin-agents @guren/plugin-cloudflare
```

`bunx guren plugin <package>` でもインストールでき、この場合はプラグインが宣言している互換性レンジも検証されます。`@guren/plugin-agents` はレジストリを引数に取る `definePlugin()` のファクトリなので、どちらの方法でも登録は手で書きます([プラグイン](./plugins.md#プラグインのインストール)を参照)。

パッケージは `devDependencies` ではなく `dependencies` に入れてください。生成されたワーカーがこのパッケージを import し、wrangler はデプロイ時に本番用のインストールからその import を解決するからです。エージェントをホストしているのに開発用の依存としてしか入れていないアプリは、`guren cloudflare:build` が受け付けません。

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

`@/config/agents` は、`make:agent` が書き出すレジストリです([スキャフォールド](#スキャフォールド)を参照)。`EventServiceProvider` がないと、監査イベントがどこにも届きません([監査ログ](./agent-tool-governance.md#監査ログ)を参照)。

`EncryptionServiceProvider` と `APP_KEY` があると、人の承認を待っていた呼び出しをエージェントが再実行できます。呼び出しの引数は、エージェント自身のストレージにアプリキーで暗号化して保存されます（[台帳](#台帳)を参照）。暗号化の仕組みがバインドされていない場合、プラグインは起動時に警告を出します。承認待ちの呼び出しは `requestId` とともにエージェントに報告されますが、自動では再実行されません。

プロバイダーを `providers` 配列のどこに置くかは関係ありません。

## スキャフォールド

```bash
bunx guren make:agent Triager
```

このコマンドは、エージェントのクラスと、新しいアプリに足りないものをまとめて書き出します。エージェントのクラスだけを置いても、読み込まれず、境界も引かれず、デプロイのビルドからも見つからず、どのアプリにも定義されていない型を参照するので、動きません。

| ファイル | 内容 |
|---|---|
| `app/Agents/Triager.ts` | クラス本体。state の形、cron のスケジュール、ツール呼び出し 1 つ |
| `config/agents.ts` | 登録エントリ。ファイルがなければ作成し、あれば書き足します |
| `guren.arch.ts` | `app/Agents/**` から `app/Models/**`・`db/**`・`@guren/orm`・`@guren/plugin-agents/runtime` への import を禁止するルール |
| `config/bindings.ts` | クラスが import する `Env`。D1 のバインディングと、エージェントの Durable Object namespace 用のコメントアウトされた枠が入っています。ファイルがなければ作成し、すでに `Env` を export していればそのままにします。以前の `make:agent` で `config/env.ts` に `Env` が書かれたアプリは、引き続きそちらから import します |
| `tsconfig.json` | `compilerOptions.types` に `@cloudflare/workers-types` を追加します。`Cloudflare.Env` と `DurableObject` はここから読み込まれます |

既存のファイルはその場で書き換えます。書き換えられなかった箇所は黙って飛ばさず、貼り付けるためのテキストと一緒に報告します。登録できたように見えて実は登録されていない、という状態が残るよりは、メッセージが 1 つ出るほうがましだからです。`types` 配列がない tsconfig や、コメントを含む tsconfig の場合は、書き換える代わりに追加すべき行を表示します。

自分で行う作業が 2 つ残ります。どちらも、最初に typecheck を実行する前に知っておいてください。

- **`src/app.ts` は変更しません。** 上の例のように、`agentsPlugin(agents)` を自分で `createApp({ providers })` に加えてください。
- **依存パッケージ。** アプリに `@cloudflare/workers-types` がなければ `bun add -d @cloudflare/workers-types` を実行します。足りないときはコマンドがそう表示します。

`config/bindings.ts` を `wrangler types` で生成せずに手書きにしているのは、この型を `tsc` と Bun のテスト実行の両方が読むからです。どちらも、先に wrangler が実行されていることを前提にはできません。また、`@cloudflare/workers-types` が宣言するのは `Cloudflare.Env` で、素の `Env` ではないので、クラスはアプリ自身の `Env` を import します。バインディングが増えたら、このファイルに書き足してください。

```ts
// config/bindings.ts
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

どのクラスがエージェントで、どこにあり、何を呼び出してよいかは、`config/agents.ts` の 1 ファイルだけに書きます。

```ts
// config/agents.ts
import { defineAgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      scopes: ['tool:tickets_index', 'tool:tickets.close'],
      budget: { callsPerMinute: 30 },
    },
  },
})
```

**このファイルは静的に書きます。** `guren cloudflare:build` は生成するワーカーにクラスごとの名前付き export を追加しますが、クラスの値からはソースのパスがわからないので、`module` と `export` にクラスのファイル名と export 名を文字列で書きます。`guren check` はこのファイルをソースとして読んでその名前を確かめるので、`agents` の中のスプレッド、計算されたキー、別の場所からの config の再 export は、それぞれ理由を添えて失敗にします。

このファイルには、ほかにも 3 つのルールがあります。

- **エージェント名は `^[A-Za-z0-9_-]+$` に従います。** 名前は呼び出し主体(principal)の id `agent:<name>:<instance>` の一部になります。コロンや空白が入ると、別々のエージェントが同じ id を作れてしまい、一方に与えた承認をもう一方が使えるようになります。
- **1 つのクラスは 1 つのエージェントです。** 実行時のレジストリも生成されたワーカーも export 名をキーにしているので、2 つの登録が同じ名前を使うと、片方に到達できなくなります。
- **`budget.callsPerMinute` は 1 以上の整数です。** 呼び出し回数を制限しない登録はできません。`budget` を書かなかったエージェントには 60 が設定されます。`Infinity` と `NaN` は、どちらもエラーを出さずに制限を無効にしてしまうので拒否されます。

### スコープ

登録時のスコープは、[トークンとスコープ](./agent-tool-governance.md#トークンとスコープ)で説明しているトークンのスコープよりも、意図的に**狭く**しています。受け付けるのは次の 2 つの形だけです。

| スコープ | 許可するもの |
|---|---|
| `tool:tickets.close` | そのツール 1 つだけ |
| `tools:read` | 解決後の `readOnlyHint` が true のすべてのツール |

`tools:*` や `tools:tickets.*` のようなプレフィックス付きの形は、発行済みのトークンでは使えますが、**登録では拒否されます**。人が見ていないところで動くエージェントに、まだ存在しないツールへの許可を先に与えないためです。

`tools:read` は生成ファイルに固定せず、`guren check` を実行したときとアプリが起動したときに、アプリのルートに対して展開します。そのため、読み取り専用でなくなったルートは、エージェントが次に起きたときから呼び出せなくなります。展開の結果は、`bunx guren check --json` の `agentScopes` で確認できます。

予算を超えた呼び出しは、`reason: 'rate-limit'` を持つ `denied` の結果として返ります。回数を数えるウィンドウはメモリ上のインスタンスにあるので、エビクションが起きるとリセットされます。これは短時間の集中を抑えるための最低限の制限で、全体の割り当て量を管理するものではありません。本当の意味での割り当て量が必要なアプリでは、共有ストアを用意し、自前の[レートリミットミドルウェア](./rate-limiting.md)で制限してください。

### 承認キューの置き場所

`config/agents.ts` は `approvals` キーも受け付けますが、キューのストアと通知は `agentsPlugin(...)` の呼び出しのほうに書いてください。レジストリには静的な登録だけを置きます。`guren check` はこのファイルをソースコードとして読み、`guren cloudflare:build` は Bun 上でこのファイルを実行するので、ここで Drizzle のストアや通知チャネルを import すると、その両方がそれらの依存を読み込めなければならなくなります。

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

`GurenAgent` は SDK の `Agent` を継承したクラスで、追加しているのは `this.tools` だけです。state、`this.sql`、スケジュール、キュー、fiber、WebSocket は SDK のものをそのまま使えます。

```ts
// app/Agents/Triager.ts
import { GurenAgent } from '@guren/plugin-agents/agent'

import type { Env } from '@/config/bindings'

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
    const listed = await this.tools.call('tickets_index', { status: 'open' })
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
| `result.ok` | 呼び出しが**ディスパッチされた**。アプリケーションが返した内容は `result.outcome` に入っている |
| `result.pending` | `approval: 'required'` のツールが呼び出しを保留した。`result.requestId` がそのリクエストを指す |
| `result.denied` | HTTP のリクエストが発生する前にゲートが拒否した。`result.reason` は `'auth'`・`'scope'`・`'approval'`・`'rate-limit'` のどれか |
| `result.failed` | ディスパッチそのものが例外を投げた |

**`ok` は成功を意味しません。** わかるのはリクエストがアプリケーションに届いたことだけです。アプリケーション自身の判定は `result.outcome.isError` に、HTTP ステータスは `result.outcome.status` に入っています。ポリシーによる 403 も、スキーマによる 422 も、どちらも `ok` として返ってきます。各バリアントでは、ほかの 3 つの判別用プロパティが存在しないと型で宣言されているので、`if (result.pending) return` と書くだけで型ガードなしに型が絞り込まれます。

`this.tools.preflight(name, args)` を使うと、実行する代わりに同じルートに可否だけを問い合わせます。[`--preflight` と `guren_preflight`](./agent-interface.md#mcp-経由で呼び出しを予行演習する) と同じ仕組みです。スコープのゲートは動き、予算も消費されますが、承認のゲートは飛ばします。承認が必要なツールこそ事前に確かめる価値があり、予行演習では何も実行されないからです。

### state に関する2つのルール

**エージェントで永続するのは identity と state で、JavaScript のスタックは永続しません。** インスタンスはしばらく使われないとエビクトされ、実行中のメソッドはそこで途切れます。次に起きたときにも必要なものは `this.setState` か `this.sql` に保存しておき、スケジュールで処理を再開してください。ローカル変数、タイマー、実行中の fetch は失われます。後述する保留中の呼び出しの台帳を、1 週間眠り続ける `await` ではなく、state とスケジュールで作っているのもこのためです。

**state の形は変わっていきますが、インスタンスは古い形のまま残ります。** `initialState` が使われるのは、**新しく作られた** Durable Object だけです。以前のデプロイで動いていたインスタンスは、そのときに書かれた state の形を持ち続けるので、あとから追加したフィールドはそのインスタンスでは `undefined` になります。これは型エラーとしては現れず、デプロイ後の最初の定期処理で `Cannot convert undefined or null to object` として発生します。上の `#current()` のように、state を読むたびに既定値の上に保存済みの値を重ねてください。

### principal

principal は、アプリの認証やポリシーから見た呼び出し元の身元です。エージェントのインスタンスはそれぞれ自分の principal を持ち、形は `agent:<name>:<instance>` です。instance の部分には Durable Object の名前が入ります。そのため、ポリシーでは運用者とエージェントを区別でき、あるインスタンスに与えた承認を別のインスタンスが使うこともできません。

この principal はプロセスの中で設定され、ネットワークを通ることはありません。`requireAuthenticated()`、`Controller.auth`、`Gate` の条件は満たしますが、発行済みの `ApiToken` を確かめる bearer トークンのチェックは、意図して満たさないようにしています。アプリケーションが発行していない認証情報を作り出すことになるからです。

## 人間を挟む

`approval: 'required'` を宣言したルートは、最初の呼び出しを拒否して保留中のリクエストを作り、承認者に通知して、エージェントに id を渡します(仕組みの全体は[承認が必要なツール](./agent-tool-governance.md#承認が必要なツール)で説明しています)。永続エージェントの場合は、これに加えて、エージェントが自分から結果を確認しに戻ってきます。

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

この `return` の裏側では、`this.tools` が `{ requestId, tool, args }` を `guren_pending_tool_calls` に保存し、確認のスケジュールを入れます。このテーブルは、エージェント自身の Durable Object の SQLite にある、フレームワークが管理するテーブルです。

承認キューは、伏せ字にした入力と元に戻せない指紋（fingerprint）しか保存しないので、再実行に必要な引数はエージェントの側に置くしかありません。それでも問題にならないよう、次の制約があります。

- このテーブルはインスタンス専用のストレージで、どの API からも見えません。
- 行はアプリキーで暗号化して保存します。
- 行は、対応する承認に答えが出るか期限が切れた時点で削除されます。期限はキューが決め、エージェントが延ばすことはできません。

エージェントは起きるたびに、承認待ちのすべての行についてキューに状態を問い合わせます。この問い合わせもほかのツール呼び出しと同じパイプラインを通るので、監査の対象になります。結果が `approved` なら、保存しておいた引数で元の呼び出しをもう一度実行します。キューは引数の指紋を照合し、承認を一度使ったら消費するので、再実行で使われるのは人が与えたその承認だけです。

<details>
<summary>問い合わせの間隔</summary>

- 最初は 30 秒後で、問い合わせるたびに間隔を倍にします。1 秒より短くはならず、最も早く期限が来る行の期限を数秒より長く超えることも、1 時間を超えることもありません。
- 確認用のスケジュールは常に 1 つだけで、1 回起きたときにすべての行を問い合わせます。そのため、新しく承認待ちになった呼び出しが、古い行の長い間隔を引き継ぐことはありません。
- メモリには何も持ちません。行もスケジュールも永続化されるので、リクエストから承認までの間にエビクションが起きても何も失われません。

</details>

### `onToolApprovalSettled`

このメソッドはオーバーライドでき、オーバーライドしなければ何もしません。どの結末になった場合も呼ばれます。

| `status` | 何が起きたか |
|---|---|
| `approved` | 人が承認した。`result` は再実行したときの答えで、それ自体が拒否の場合もある |
| `rejected` | 人が拒否した。何も呼び出していない |
| `expired` | 申請の期限が切れた。回答がなかった場合と、承認されたが使われないまま切れた場合がある |
| `unknown` | このリクエストの記録がキューにもう残っていない |
| `unreadable` | 台帳の行を復号できなかった（アプリキーを `previousKeys` に残さずにローテーションした場合や、行が壊れている場合）。引数が失われたので、再実行できるものはない |

`args` には、保留された呼び出しの引数が入っています。入っていないのは `'unreadable'` のときだけです。キューは引数を復元できる形で持たないので、人が**どの呼び出し**に答えたのかをアプリケーションが知る手段はここしかありません。

<details>
<summary>定期処理が中断したときの扱い</summary>

`status` と `result` を分けているのは、次のケースがあるからです。再実行は済んだものの、行を消す前に定期処理が中断した場合、次の定期処理は承認がすでに使われていることに気づき、何も呼び出さずに `status: 'approved'` で **`result` なし**として決着させます。ここでもう一度呼び出すと、使われていない承認が見つからないので新しいリクエストを作り、人をもう一度呼び出し、承認されればアクションを 2 回実行してしまいます。

定期処理は例外を投げないように書いてあります。SDK は失敗したスケジュールのコールバックを 3 回まで試し、それでも失敗するとスケジュールを破棄します。そのため、壊れた行が 1 つあるだけで定期処理全体が最初からやり直しになり、ほかの行も起きるきっかけを失ってしまうからです。行は 1 つずつ別々に処理し、アプリ側のフックが例外を投げた場合は報告したうえで握りつぶします。

予算不足で拒否された再実行は、行を残しておきます。人が与えた承認を、拒否される呼び出しで使ってしまわないためです。

</details>

### ストアと運用者側は自分で書く

承認ストアには既定の実装がありません。監査の出力先に既定がないのと同じ理由で、プロセスのメモリに逃げる実装にすると、次の isolate が知らないレコードに対して「承認済み」と答えてしまうからです。`AgentApprovalStore` を実装し(4 つのメソッドと 2 つの保証は[キューを設定する](./agent-tool-governance.md#キューを設定する)で説明しています)、リクエストの解決は自分で用意したルートで行ってください。

[`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents) には、Drizzle による実装と、その上に作った 2 種類の運用画面があります。1 つは `curl` で操作する JSON API、もう 1 つはチケット、保留中の承認、エージェント自身のレポートを 1 画面に並べたブラウザのコンソールです。どちらの形でもルールは同じなので、デプロイの形に合うほうを参考にしてください。

この 2 つの運用画面を作ってわかったことのうち、自分で実装するときにも取り入れてほしいものが 4 つあります。

- **status はカラムを読まずに導き出す。** 受付期間が終わったリクエストも、SQL の上ではまだ `pending` に見えます。回答できるものの一覧からは外してください。
- **二重の回答には 409 を返す。** すでに誰かが決着をつけたリクエストも、受付期間が終わったリクエストも、今は回答できません。`404` は、その id のリクエストが存在しないという意味だけに使います。
- **保持期間はポリシーの問題として扱う。** 決着したリクエストは、エージェントが何を許されたかの記録です。古い記録の削除は、スケジュールに勝手に判断させず、運用者が呼び出すルートで行うのがよいでしょう。
- **画面がいくつあってもルールは 1 つにする。** 例のコンソールと JSON API は、承認の解決を 1 つの共有モジュールに任せています。「どの行に回答できるか」の判定を 2 か所に書くと、人が一度だけ与えた許可を、もう一方の判定がエージェントに再び渡してしまうからです。違うのは見せ方だけで、コンソールは元のページにリダイレクトして拒否理由をフラッシュメッセージで表示し、API はステータスコードで返します。

bearer の API の隣にブラウザのコンソールを置くのに必要な配線は、見た目ほど多くありません。CSRF 対策は `createApp({ auth })` がアプリ全体に適用しますが、ツールのルートは独自の条件で対象外になります(cookie を持たない bearer のリクエストと、パイプラインが principal を設定したリクエストはどちらも検査を飛ばします)。そのため、除外リストを手で書く必要はありません。

一方で、注意が必要な点が 2 つあります。1 つは、セッションストアをデータベースを使う実装にすることです。Workers では、ログイン後のリダイレクトとリダイレクト先のページを別々の isolate が返すからです。もう 1 つは、`.agent()` を持つルートが JSON を返し続けるようにすることです。描画したページはツールの結果にならないので、エージェントのルートが Inertia のレスポンスを返すと `guren check` が警告します。

永続エージェントが自分で承認の状態を確認したときも、MCP クライアントが `guren_approval_status` で受け取るのとまったく同じ答えが、同じルールで返り、同じツール名で監査されます。区別しないように作ってある部分も同じです。存在しない id と、ほかの principal の id に対しては同じメッセージを返すので、どちらの窓口を使っても、同僚がどの承認を待っているかを列挙することはできません。

## Workers へのデプロイ

エージェントは、通常の Cloudflare 向けビルドにそのまま載ります。D1、セッション、静的アセット、シークレットなど、デプロイのほかの部分については [Cloudflare Workers デプロイ](./cloudflare.md)を参照してください。

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

アプリに `config/agents.ts` があると、ビルドはワーカーに Durable Object 側の処理も生成します。手で編集することはありませんが、次の節以降で検査する内容の前提になっています。

<details>
<summary>生成されたワーカーが追加するもの</summary>

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

登録したクラスごとに名前付きの export があるので、wrangler は Durable Object のバインディングの向け先を決められます。アプリの起動処理は、2 つのエントリポイントで 1 つを共有しています。どのリクエストもまだアプリを起動していない段階で alarm がエージェントを起こすことがあり、その場合はエージェントがアプリを起動し、あとから来たリクエストは 2 回目の起動を始めずにその起動に合流します。

バインディングの一覧を明示しているのは、そうしないと SDK のルーターが `env` の中のすべての Durable Object にアクセスできてしまうからです。

</details>

### バインディング検証

ビルドはコミット済みの `wrangler.jsonc` を読み、登録したクラスに SQLite を使う Durable Object のバインディングがなければ、そこで処理を止めます。このチェックはアプリのビルドを始める前に行うので、Vite の出力を何分も待ったあとで止まることはありません。これらのエントリは手で書かず、ビルドを実行して表示された JSON を貼り付けてください。

この検証について、補足が 3 つあります。

- **wrangler の 2 つの書き方のどちらにも対応しています。** 以前からある `migrations[].new_sqlite_classes` のリストと、宣言的な `exports` のマップ(`{ "type": "durable-object", "storage": "sqlite" }`)です。wrangler はこの 2 つを同時には使えないものとして扱うので、どちらか一方を使ってください。新しく生成した雛形は migrations の形になります。Agents SDK のドキュメントに載っているのがこちらだからです。
- **名前付きの環境はそれぞれ個別に検証します。** `durable_objects` は `env.<name>` のブロックに引き継がれないので、トップレベルではクラスをホストしているのに、実際にデプロイする環境ではホストしていない、という設定もここで見つかります。
- **`"keep_names": false` は拒否します。** エージェントのクラスは、実行時に自分の名前で探されます。`keep_names` を無効にすると esbuild がクラス名を変えることがあり、問題なく終わったように見えたデプロイのあとで、すべてのツール呼び出しが "is not registered" で失敗します。この拒否は、エージェントがあるかどうかに関係なくすべてのアプリに適用されます([Cloudflare Workers へのデプロイ](./cloudflare.md#ビルドとデプロイ))。`"minify": true` は問題ありません。wrangler は、`keep_names` で無効にしない限り、minify しても名前を残します。

### インスタンスに誰が到達してよいか

エージェントを登録すると、生成されたワーカーは `/agents/` プレフィックス全体を SDK のルーター用に確保し、その下を**すべて拒否**します。許可を宣言するまで、その下へのリクエストと WebSocket のアップグレードはすべて 403 で拒否されます。拒否は Durable Object が作られる前に行われるので、認可されていない呼び出し元のせいでコールドスタートが発生することもありません。

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

リクエストを通すなら `true`、403 にするなら `false`、自分で応答するなら `Response` を返します。`routeAgentRequest` はルーターで、認証の層は持っていません。その層にあたるのがこの関数です。どういう形が正しいかがまだ固まっていないので、ポリシーのための語彙は用意せず、あえて述語 1 つにしています。

**自分で作る運用向けのルートは、`/agents/` プレフィックスの外に置いてください。** この下に登録したルートは、拒否されるどころか、そもそも到達できません。`examples/agents` では `/ops/agents/…` というパスを使っています。

### エージェントと話す

アプリケーションが自分のエージェントとやり取りするときは、HTTP ではなくバインディングを使います。

```ts
// app/Http/Controllers/AgentOpsController.ts
import { Controller } from '@guren/core'
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

import type { Env } from '@/config/bindings'

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

エージェントのクラスの public メソッドは、どれも stub から呼び出せます。`bun run dev` では Durable Object の namespace がないので、503 を返すのが正直な応答です。アプリのエージェント側は、`wrangler dev --local` と本番環境で動きます。

### シークレットとデータベース

```bash
bunx wrangler secret put APP_KEY
```

台帳はこの鍵で暗号化します。鍵がないと、`agentsPlugin` は起動時に警告を出し、再実行を一切行いません。`.dev.vars` はコミットしないでください。

承認ストアはふつうのテーブルなので、スキーマのほかの部分と同じく D1 に置きます。マイグレーションで作成し、`wrangler d1 migrations apply` を使ってアプリとは別に適用してください。Workers ではアプリが自分でマイグレーションを実行することはありません。

### 無料プラン

リファレンスアプリを Workers の**無料**プランのアカウントにデプロイし、`wrangler tail` で計測しました([全体の表は README にあります](https://github.com/gurenjs/guren/tree/main/examples/agents))。呼び出しが保留されてから 30 秒後、Worker にリクエストが 1 件も届かないまま alarm が発火し、再実行によってチケットがクローズされました。

プランにどこまで収まるかの目安になる数字は次の 3 つです。起動に約 100 ms、Durable Object の定期処理全体(起動、ツール呼び出し 2 回、承認レコード 2 件)に CPU 時間で 47 ms、台帳の alarm に 14 ms でした。

見積もりの際に気にしておくべき上限が 2 つあります。

**Worker の 1 回の呼び出しあたり CPU 10 ms。** ウォームなリクエストは 4 ms でした。コールドな isolate でアプリケーションを起動するリクエストは 20〜30 ms かかりましたが、それでも `outcome: ok` になっています。Cloudflare がこの上限を厳密な打ち切りではなく、ある程度の超過を許して運用しているからです。とはいえ、上限を超え続ける Worker はエラー 1102 で失敗し始めることがあります。Durable Object にはずっと大きな独自の予算があるので、危ないのはエージェントの処理ではなく、運用 API がコールドな状態で起動するときです。`bunx wrangler tail` の `cpuTime` を見ておき、1102 が出るようなら、有料プランにすれば上限がなくなります。

**Worker の 1 回の呼び出しあたり D1 クエリ 50 件**(有料プランでは 1,000 件)。しかも、定期処理はまるごと 1 回の Durable Object の呼び出しの中で動きます。そこで、1 回の定期処理で新たに問い合わせる件数に上限を設け、残りは次回に回すものとして報告します。

```ts
const MAX_ASKS_PER_SWEEP = 10
```

この計算は、自分のツールに合わせてやり直してください。リファレンスアプリでは、index の呼び出しが 1 クエリ、新しい承認 1 件ごとに `findMatch` と `create` の 2 クエリなので、定期処理全体で 1 + 2 × 10 = 21 に収まります。

同じ上限は、1 分あたりの予算を守るのにも役立ちます。上限がないと、たまった処理の最初の数件でウィンドウを使い切ってしまい、その後ろがすべて待たされます。

すでに保留中の項目を覚えておくことも忘れないでください。そうしないと、定期処理のたびに同じ問い合わせを繰り返すことになります。

**1 日あたり**の割り当ては別の上限ですが、たいていはここが制約になることはありません。1 時間ごとの定期処理と数件の保留中の承認なら、起きる回数は 1 日に数十回で済みます。

## テスト

テストも、ランタイムの分かれ方に合わせて分けます。

**エージェントのロジックは Bun でテストする。** エージェントが `this.tools` を通して行うことは、すべて[ツールをテストする](./agent-interface.md#ツールをテストする)で説明しているディスパッチの契約に沿っているので、workerd を使わずに `TestApp` に対して動かせます。純粋な判断の部分(どれが古いか、どれを問い合わせるか、上限までに何件許すか)は別のモジュールに切り出して、直接テストしてください。Durable Object は Bun では動かせませんが、この計算部分は動かせます。

**Durable Object の挙動は workerd でテストする。** alarm からの起動、名前付き export、ルーティングのガード、エビクション後の承認の再実行は、まさにモックでは確かめられない部分です。これらは [`@cloudflare/vitest-plugin`](https://www.npmjs.com/package/@cloudflare/vitest-plugin) を使い、代わりのものではなく**生成された**ワーカーに対して実行してください。そうすれば、ビルドの配線そのものもテストの対象になります。このパッケージには `evictDurableObject` があるので、「再実行はエビクションのあとも動く」ことを主張するだけでなく、実際にアサーションで確かめられます。

Guren のリポジトリにある 2 つのスイートが、それぞれの形の例です。workerd でのテストは[プラグインの workerd テスト](https://github.com/gurenjs/guren/tree/main/packages/plugin-agents/tests/workers)、アプリケーション側のテストは [`examples/agents/tests`](https://github.com/gurenjs/guren/tree/main/examples/agents/tests) です。

## チェックが守るもの

`bunx guren check` は、`config/agents.ts` があれば自動でエージェントのレジストリを読み取り、なければ何も報告しません。ただし、すべてのルールを `check` が見ているわけではないので、ルールごとの報告元を次にまとめます。

| ルール | 報告元 |
|---|---|
| レジストリが静的な `defineAgentsConfig()` のリテラルで、`module`、`export`、`scopes` が正しい | `guren check`(失敗) |
| `tool:` スコープが、どこかのルートが宣言しているツールを指している | `guren check`(警告) |
| `app/Agents/**` がモデル、`db/**`、`@guren/orm`、`@guren/plugin-agents/runtime` を import していない | `guren check`、または `check --arch` 単体(失敗) |
| エージェントが呼び出す読み取り専用でないツールに、認可がかかっている | `guren check`(失敗。エージェントルートのルール) |
| エージェント名が `^[A-Za-z0-9_-]+$` に合い、`budget.callsPerMinute` が 1 以上の整数である | `agentsPlugin`(アプリの起動時) |
| `@guren/plugin-agents` が実行時の依存にあり、各クラスに SQLite の Durable Object バインディングがあり、`keep_names` が `false` でない | `guren cloudflare:build`(デプロイ前) |

以下では `guren check` の行を詳しく見ていきます。起動時のルールは[レジストリ](#レジストリ)で、ビルドのルールは[インストールと登録](#インストールと登録)と[バインディング検証](#バインディング検証)で説明しています。

`check` が**失敗**(failure)にするのは、`check` 自身かデプロイのビルドが読み取れないレジストリです。具体的には、パースできないファイル、リテラルの `defineAgentsConfig({ agents: { … } })` になっていない config、`agents` の中のスプレッド、リテラルでない `module` や `export`、存在しないファイルを指す `module`、そのクラスをクラス宣言として export していないモジュール、重複したエージェントのキーや export 名、欠けているかリテラルでない `scopes` 配列、登録の書き方から外れたスコープが該当します。

どのルートも宣言していないツールを指す `tool:` スコープには**警告**(warn)を出します。そのようなスコープは何も許可しないので、セキュリティの穴ではなく、タイプミスかルートの名前の変更を示しています。

`bunx guren check --arch` は、雛形が書いた境界を守らせます。`app/Agents/**` のファイルが `app/Models/**`、`db/**`、`@guren/orm`、`@guren/plugin-agents/runtime` を import していれば失敗になります。

ただし、**この境界はチェッカーが守らせる約束事で、サンドボックスにはなりません。** 同じプロセスで動くアプリケーションのコードは isolate を共有しているので何でも import できますし、チェッカーが見るのは静的な import だけなので、動的な `import()` はすり抜けます。この境界によって得られるのは、境界をまたぐコードがうっかり紛れ込まず、レビューで目に見えるようになることです。残りは監査ログが補います。

エージェントが呼び出すルートは、通常のエージェントルートのルールでチェックされます。ここで特に大事なのは、読み取り専用でないツールには認証だけでなく**認可**が必要だという点です。[認証は認可ではありません](./agent-interface.md#認証は認可ではありません)を参照してください。

## 関連

- [エージェントインターフェース](./agent-interface.md): `.agent()` ルートと、そこからのツールの導出
- [エージェントツールの権限と監査](./agent-tool-governance.md): スコープ、承認、エージェントの呼び出しが記録される監査ログ
- [AI エージェント](./ai-agents.md): リクエスト、ジョブ、永続エージェントから、アプリのツールを使ってモデルを呼び出す
- [Cloudflare Workers デプロイ](./cloudflare.md): デプロイのほかの部分(D1、セッション、シークレット、静的アセット)
- [認可](./authorization.md): `agent:<name>:<instance>` という呼び出し主体に何を許すかを決めるポリシー
- [暗号化](./encryption.md): `APP_KEY` と、台帳に必要な encrypter
- [CLI](./cli.md): `make:agent`・`check`・`audit`・`tool:list`
- [RFC 0017: Durable Agent Runtime](https://github.com/gurenjs/guren/blob/main/rfcs/0017-durable-agent-runtime.md): 設計と、実装が設計から外れたすべての箇所
- [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents): 実際に動くトリアージのエージェント、その承認ストア、運用 API とブラウザのコンソール、無料プランでの実測値
