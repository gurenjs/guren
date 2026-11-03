# AI エージェント

AI エージェントは、アプリケーションの中で言語モデルを呼び出すクラスです。エージェントがアプリケーションに触れる手段は、ルートがすでに宣言しているエージェントツールだけです。`@guren/plugin-ai` は [Vercel AI SDK](https://ai-sdk.dev) の上に作られていて、プロバイダとの通信は SDK が受け持ちます。モデルがどのルートを誰として呼べるか、何を記録するかは、プラグインが決めます。

エージェントのガイドは 3 つあり、それぞれ次の問いを扱います。

| ガイド | 問い |
|---|---|
| [エージェントインターフェース](./agent-interface.md) | エージェントはこのアプリケーションに何ができるか(`.agent()` ルート。スコープ、承認、監査は[エージェントツールの権限と監査](./agent-tool-governance.md)) |
| AI エージェント(このガイド) | アプリケーションのコードから、そのツールを使う仕事をどうモデルに頼むか |
| [永続エージェント](./durable-agents.md) | 自分の state とスケジュールを持つ長命なエージェントをどこで動かすか |

このガイドのエージェントは、呼び出し元のリクエスト・ジョブ・コマンドの中で動きます。呼び出しをまたいで残るのは、保存を指定した会話履歴だけです。永続エージェントがモデルを呼ぶときに、このエージェントを使うこともできます。

## インストール

```bash
bunx guren add ai
```

このコマンドには `config/env.ts` が必要です([設定](./configuration.md)を参照)。書き込む内容は次のとおりです。

- 1 つのプロバイダ用の `config/ai.ts`。プロバイダは `--provider anthropic`(既定)、`openai`、`gateway` から選びます。
- `config/env.ts`、`.env.example`、`.env` に追加するプロバイダの API キー。キーは optional かつ secret として宣言されるので、キーがなくてもアプリは起動します。その場合は、最初のプロンプトがキー名を示すエラーで失敗します。
- `createApp({ config })` への `config/ai.ts` の登録と、`createApp({ providers })` への `aiPlugin()` の登録。
- `db/schema.ts` を持つアプリでは、`ai_conversations` と `ai_messages` のテーブル、そのマイグレーション、`config/ai.ts` の `conversations` 設定。`--no-conversations` を付けると3つとも省きます。

最後に `bun add @guren/plugin-ai ai <プロバイダのパッケージ>` を実行します。`--no-install` を付けると、実行はせずにコマンドを表示します。プラグインを動かすには Node 22 以降か Bun が必要です。

Anthropic を選んだときには、次の設定が生成されます。

```ts
// config/ai.ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { defineAiConfig } from '@guren/plugin-ai'
import { aiConversations, aiMessages } from '../db/schema'

export default defineAiConfig((env) => ({
  default: 'anthropic',
  providers: {
    anthropic: {
      model: () => {
        if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in .env to call the anthropic provider.')
        return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5-5')
      },
    },
  },
  conversations: { driver: 'database', conversations: aiConversations, messages: aiMessages },
}))
```

`model` の中のガードは消さないでください。検証済みの env は `process.env` にコピーされないので、キーは明示的に渡します。渡さないとプロバイダのパッケージが自分で `process.env` を読みにいき、空の `ANTHROPIC_API_KEY=` 行の値が本物のキーとして API に送られてしまいます。

既定のモデルは Claude Opus 5.5(`claude-opus-5-5`)で、API の振る舞いが Claude Opus 5 と 2 点違います。

effort の既定値は `medium` で、Claude Opus 5 の `high` より 1 段低くなっています。thinking はオフにできないので、調整できるのは effort だけです。プロバイダを通るすべての呼び出しを別の段階で動かすには、AI SDK の `defaultSettingsMiddleware` でモデルを包みます。

```ts
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai'

anthropic: {
  model: () => {
    if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in .env to call the anthropic provider.')
    return wrapLanguageModel({
      model: createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5-5'),
      middleware: defaultSettingsMiddleware({ settings: { providerOptions: { anthropic: { effort: 'high' } } } }),
    })
  },
},
```

ツールの強制指定(`tool_choice` の `any` や特定ツールの指定)は 400 になります。`@ai-sdk/anthropic` 4.0.78 以降はこのモデルを知っていて、`toolChoice: 'required'` やツール名の指定を警告付きで `auto` に落とし、エージェントの `output` スキーマを強制ツール呼び出しではなくネイティブの構造化出力(`output_config.format`)で送ります。`guren add ai` は `@ai-sdk/anthropic@^4.0.78` をインストールします。古い版に固定しているアプリは上げてください。

`providers` は、名前とファクトリの対応表です。各ファクトリは、その名前を使う最初のプロンプトで 1 度だけ実行され、結果はメモ化されます。エージェントはプロバイダの名前を指定するだけで、モデルのインスタンスは持ちません。そのため、テスト用のフェイク(`fakeAi()`)で、アプリケーションから使えるすべてのモデルを差し替えられます。

2 つ目のプロバイダを加えるときは、そのパッケージをインストールしてエントリを足します。

```ts
providers: {
  anthropic: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5-5') },
  fast: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-haiku-5-5') },
},
```

`default` はエントリのどれかを指していなければならず、そうでないと起動に失敗します。エントリには `embeddingModel` と `imageModel` のファクトリも書けます。今のところ、プラグインの中でこれを使うのは `ai.embeddingModel(name)` だけです。これは、AI SDK の `embed()` を自分で呼ぶコードに埋め込みモデルを返します。

## エージェントを書く

```bash
bunx guren make:ai-agent TicketDigest --tools tickets_index --output --test
```

`--tools` を付けると、ファイルを書き込む前に、指定した各名前がルートから導出されるツールの中にあるかを確かめます。`--output` は構造化出力のスキーマを、`--test` はモデルの応答をスクリプトで決めるテストを追加します。`--module <name>` を付けると、モジュールの中に書き込みます。[永続エージェント](./durable-agents.md)を生成する `make:agent` とは別のコマンドです。

次の例は、[`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents) のエージェントを短くしたものです。

```ts
// app/Ai/Agents/TicketDigest.ts
import { Agent, Output } from '@guren/plugin-ai'
import { z } from 'zod'

const Digest = z.object({
  summary: z.string(),
  staleTicketIds: z.array(z.number().int()),
})

export class TicketDigest extends Agent<typeof TicketDigest.scopes> {
  static override agentName = 'ticket-digest'
  static override scopes = ['tool:tickets_index'] as const

  instructions = 'You write a short digest of the open support tickets for an operator.'

  output = Output.object({ schema: Digest })

  override tools() {
    return this.appTools(['tickets_index'])
  }
}
```

| メンバー | 意味 | 既定値 |
|---|---|---|
| `instructions` | システムプロンプト。 | 必須 |
| `provider` | `config/ai.ts` のプロバイダ名。 | `config/ai.ts` の `default` |
| `tools()` | モデルが呼べるツール。呼び出し主体(principal)が決まった後で実行するため、メソッドとして書きます。 | `{}` |
| `output` | パース済みで型の付いた結果を得る `Output.object({ schema })`。 | テキスト |
| `stopWhen` | ツールループを止める条件。例: `stepCountIs(5)`。 | 20ステップ |
| `settings` | モデルを呼ぶたびに送る AI SDK のコール設定。`maxOutputTokens`、`temperature`、`providerOptions` など。 | なし |
| `continueWhen` | 最後のステップで終わったターンを、`prompt()` がモデルをもう一度呼んで再開するかどうか。例: `isPausedTurn`。 | 再開しない |
| `maxContinuations` | 1 回のプロンプトで `continueWhen` が再開できる回数。 | 5 |
| `static agentName` | フェイク・監査ログ・キュー実行が使う名前。 | クラス名 |
| `static scopes` | `appTools()` がモデルに渡してよいアプリケーションのツール。 | `[]` |

`agentName` は明示して固定してください。既定値のクラス名は識別子を短縮するバンドラに書き換えられ、そうなると名前が変わる前にキューに入った実行や保存済みの会話を解決できなくなります。

`Agent`、`Output`、`tool`、`stepCountIs` はすべて `@guren/plugin-ai` から export されているので、エージェントのファイルが import するパッケージは1つで済みます。

### コール設定

`settings` には、AI SDK がコール設定(call settings)と呼ぶものを書きます。エージェントがモデルを呼ぶたびに送られます。出力の上限、サンプリング、リトライ、ヘッダー、タイムアウト、`toolChoice`、`providerOptions` が書けます。プロバイダ固有のオプションは、プロバイダ名をキーにして `providerOptions` に入れます。

```ts
import { Agent, type AgentCallSettings } from '@guren/plugin-ai'

export class AdditiveResearcher extends Agent {
  instructions = 'Research the additive and write a cited report.'
  override settings: AgentCallSettings = {
    maxOutputTokens: 32_000,
    providerOptions: { anthropic: { effort: 'medium', cacheControl: { type: 'ephemeral' } } },
  }
}
```

この位置に Anthropic の `cacheControl` を書くと、リクエスト全体でプロンプトキャッシュが有効になります。モデル、instructions、ツール、`output`、`stopWhen` はクラス自身のメンバーのままで、`settings` に同じ名前のキーがあっても置き換わりません。

設定はクラスに書くもので、`prompt()` の呼び出しごとには渡しません。そのため、キューに入れた実行も同じ設定で動きます。設定だけが違う 2 つのプロバイダは、1 つのプロバイダと 2 つのエージェントにまとめられます。

### 一時停止したターンを再開する

プロバイダが、ターンの途中でレスポンスを終えることがあります。Anthropic は、サーバー側のツールループ(Web 検索・Web 取得)が長引くと `pause_turn` で止めます。一時停止したレスポンスに、結果を待っているサーバー側のツール呼び出しが残っていれば、AI SDK が自分でターンを再開します。残っていないときは、AI SDK はこの停止を `finishReason: 'stop'` として返すので、ツールループは調査の途中で終わってしまいます。

`continueWhen` を書くと、`prompt()` がそのターンを再開します。

```ts
import { Agent, isPausedTurn } from '@guren/plugin-ai'

export class AdditiveResearcher extends Agent {
  override continueWhen = isPausedTurn
}
```

ツールループが終わると、`prompt()` は最後のステップを `continueWhen` に渡します。`true` が返るあいだ、`prompt()` はそこまでのターンを後ろに付け、新しいユーザーメッセージは足さずに、モデルをもう一度呼びます。これが Anthropic で一時停止したターンを再開する方法です。`as(null)` でも動き、会話にはターン全体が 1 回だけ保存されます。

`isPausedTurn` は `step.rawFinishReason === 'pause_turn'` を見るだけのただの関数なので、ほかのプロバイダの条件も同じ形で書けます。

追加の呼び出しは `maxContinuations`(既定 5)回までです。上限に達すると、`rawFinishReason` が `'pause_turn'` のままのレスポンスが返るので、確かめてください。`stopWhen` は呼び出しごとに数え直すため、1 回のプロンプトは最大で `stopWhen` のステップ数の `maxContinuations + 1` 倍まで進みます。

`steps`、`sources`、`usage` はすべての呼び出しを含みます。`text` は、アプリケーションのツールを最後に呼んだステップより後の、すべてのステップの text をつなげたものです。そのため、一時停止で複数のステップに分かれたターンも、全体が読めます。AI SDK 自身の `text` は最後のステップのものだけです。

`stream()` と `broadcast()` は再開しません。

`output` と `continueWhen` の両方を宣言したエージェントは、`as()` の時点で拒否されます。AI SDK は呼び出しのたびに最後に出力をパースするので、一時停止した呼び出しは再開する前に失敗するためです。調査はテキストで答えるエージェントにさせ、その答えを別のエージェントでスキーマの形にしてください。Anthropic では、もともと構造化出力と検索の引用を一緒には使えません。

### プロンプトを送る

コントローラ・ジョブ・コマンドの中では、コンテナから `ai` マネージャを取り出し、エージェントを呼び出し主体(principal)に結び付けてからプロンプトを送ります。

```ts
// app/Http/Controllers/AgentOpsController.ts
import { Controller } from '@guren/core'
import { TicketDigest } from '../../Ai/Agents/TicketDigest'

export default class AgentOpsController extends Controller {
  async digest(): Promise<Response> {
    const operator = await this.auth.userOrFail<{ id: number }>()
    const response = await this.make('ai')
      .agent(TicketDigest)
      .as(operator)
      .prompt(`Today is ${new Date().toISOString().slice(0, 10)}. Write the digest.`)

    return this.json({ digest: response.output })
  }
}
```

`response` には、`text`、`output`(クラスの `output` スキーマから型が付きます。宣言がなければテキスト)、`steps`(ツール呼び出しを含む AI SDK のステップ)、全ステップを合計した `usage`、`finishReason` が入ります。結果が大事な場面では `finishReason` を確かめてください。`'length'` なら、モデルがトークンを使い切っていて、出力は途中で切れています。

ほかに、`rawFinishReason`(`'pause_turn'` のような、プロバイダ自身の終了理由)、`sources`(全ステップの検索結果と引用を順に並べたもの)、`providerMetadata`(最後のステップのもの。ステップごとのものは `steps` にあります)、`modelId`(プロバイダが返した、答えたモデルの名前)も入ります。

### 実行にかかった費用

`usageOf(response)` は、レスポンスのトークン数を読み、プロバイダ側で実行されたツール呼び出し(Web 検索など)をツール名ごとに数えます。エラーで返った呼び出しは数えません。`computeCostUsd(usage, pricing)` はそれに値段を付け、`addUsage()` は 2 つの usage を足します。どれも eval のランナーが使っている関数です。値段は `config/ai.ts` に書けば、eval もそこから読みます。

```ts
// config/ai.ts: 100 万トークンあたりの USD と、サーバー側ツールの 1,000 回あたりの USD
research: {
  model: () => anthropic('claude-sonnet-5-5'),
  pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, perThousandRequests: { web_search: 10 } },
},
```

```ts
import { computeCostUsd, usageOf } from '@guren/plugin-ai'

const ai = this.make('ai')
const response = await ai.agent(AdditiveResearcher).as(null).prompt(input)
const usd = computeCostUsd(usageOf(response), ai.config.providers.research?.pricing)
```

`perThousandRequests` のキーは、エージェントの `tools()` でそのツールに付けた名前です。ここにないツールはトークン分だけが計上されます。Anthropic の Web 取得はそれで正しい値になります。`pricing` がないと、`computeCostUsd()` は 0 ではなく `undefined` を返します。

`userOrFail()` には `id` を持つ型引数を渡してください。型引数がないと `Authenticatable` が返り、`as()` はそれを受け付けません。

コンテナを持たないコードでは、`TicketDigest.as(user).prompt(...)` と書くと、既定のアプリケーションを通して同じ呼び出しになります。`TicketDigest.prompt(input)` は `as(null).prompt(input)` と同じです。1 回だけの呼び出しなら、`agent({ instructions, agentName, scopes, tools })` で無名のエージェントクラスを作れます。

### principal

`as(principal)` は、結び付けたエージェントのすべてのツール呼び出しについて、モデルが誰として振る舞うかを固定します。受け付けるのは、ユーザーのレコード、`AgentPrincipal`(`{ kind: 'user' | 'service', id, abilities? }`)、`null` のどれかです。

保持されるのは `kind`、`id`、`abilities` だけです。ツール呼び出しはリクエストとしてルートに届き、ルートは設定済みのユーザープロバイダでユーザーを組み立て直します。そのため、渡したオブジェクトにロールやテナントのフィールドがあっても、ポリシーには届きません。

呼び出し主体が `abilities` を持っている場合、エージェントが使えるツールは、クラスの `scopes` とその abilities の両方が許可するものに絞られます。呼び出し側の同意によってエージェントの権限が狭まることはあっても、広がることはありません。

`as(null)` は匿名の実行で、定期的な要約のように、誰かが起動したわけではない処理に使います。このとき `appTools()` が受け付けるのは、ルートが読み取り専用(read-only)と宣言しているツールだけです。渡した名前のうち、この条件を満たさないものはすべて、構築時のエラーに名前が並びます。

匿名のリクエストには、書き込みを認可したり承認したりする相手(identity)がいません。そのため、ツールを呼ぶたびに拒否するのではなく、エージェントを組み立てる時点で拒否します。

## アプリケーションのツール

`this.appTools(names)` は、`.agent()` ルートから組み立てたツールをモデルに渡します。どの呼び出しも、MCP エンドポイント、`guren tool:call` コマンド、永続エージェントと同じ呼び出しパイプラインを通ります。

1. スコープゲートが、ツールをエージェントの `scopes` と照らし合わせます。
2. 呼び出しは、呼び出し主体を載せたルートへのリクエストになり、`requireAuthenticated()`、`this.auth`、ポリシーがそのユーザーについて判定します。
3. `approval: 'required'` を宣言したツールは、承認ゲートで止まります。
4. 呼び出しは `surface: 'in-process'` として監査ログに記録され、引数は伏せ字(redact)にされます。

スキーマや認可ルールを、エージェント用にもう 1 つ書く必要はありません。ツールの説明、入力スキーマ、出力は、[エージェントインターフェース](./agent-interface.md#メタデータのフィールド)にあるとおりルートから導出されます。

### スコープ

`static scopes` の文法はトークンのスコープと同じです。

| スコープ | 許可するもの |
|---|---|
| `tool:tickets_index` | そのツール1つ |
| `tools:tickets.*` | 名前が `tickets.` で始まるすべてのツール |
| `tools:read` | 読み取り専用のすべてのツール |
| `tools:*` | すべてのツール |

できるだけ `tool:` の形を使ってください。プレフィックスや `tools:read` による許可は、該当するルートに `.agent()` を付けるたびに、気づかないうちに広がっていきます。また、プレフィックスはドットの位置までしか一致しないので、`tools:tickets.*` は、どのプロバイダでも通る名前 `tickets_index` を付けたツールには届きません(後述)。

`appTools()` は、次のどれかに当たると構築を拒否し、問題をすべて並べた 1 つのエラーを出します。名前に一致するルートがない場合、`scopes` がその名前を許可していない場合、`scopes` の要素が文法に合わない場合、`as(null)` の実行で読み取り専用でないツールを指定した場合です。エラーは `as()` の時点で出るので、設定を間違えたエージェントは最初のテストで失敗します。モデルが見つけられないツールを抱えたまま動き出すことはありません。

### ツール名の型

プラグインに依存するアプリで `bunx guren codegen` を実行すると、生成される `.guren/agents.gen.ts` によって `appTools()` に型が付きます。どのルートからも導出されない名前はコンパイルエラーになり、各ツールの入力と結果にはルートの契約から型が付きます。

`scopes` を `as const` で宣言し、`extends Agent<typeof TicketDigest.scopes>` と書くと、どの `tool:` 要素にも許可されていない名前もコンパイルエラーになります。型パラメータを書かなければ、コンパイル時に確認されるのは名前だけです。プレフィックスによる許可は `as()` の実行時に確認されます。

### モデルが受け取る結果

ツールの結果は、次の 3 つの形のどれかです。

- 成功したときは、ルートのレスポンスボディ
- ルートがエラーのステータスを返したとき(検証の 422、ポリシーの 403 など)は `{ error: true, status, body }`
- ゲートが拒否して何も実行されなかったときは `{ denied, message, approval? }`。承認が必要なツールでは `approval` に保留中のリクエスト(`status`、`requestId`、`expiresAt`)が入るので、モデルは承認待ちであることをユーザーに伝えられます

アプリが起動できなかったときのように、ディスパッチそのものが失敗した場合はツールの中で例外になり、AI SDK がそれをツールのエラーとしてモデルに伝えます。

### ツール名はそのままプロバイダに届く

Anthropic と OpenAI が受け付けるツール名は、`[A-Za-z0-9_-]{1,64}` に一致するものだけです。`tickets.index` という名前のルートからは API に拒否されるツールができてしまうので、`appTools()` はそのツールをまとめるときに 1 度だけ警告を出します。ルートには、どのプロバイダでも通るツール名を付けてください。ルート名、`route()` ヘルパー、パスはそのままです。

```ts
router.get('/tickets', {
  name: 'tickets.index',
  output: TicketListResponseSchema,
  agent: { description: 'List tickets, optionally filtered by status.', toolName: 'tickets_index' },
}, [TicketController, 'index'])
```

### 監査ログと承認

`aiPlugin()` は `mcpPlugin()` と同じ `audit` と `approvals` のオプションを受け取ります。

```ts
aiPlugin({
  audit: { file: 'storage/logs/agent-audit.log', days: 30 },
  approvals: { store: approvalStore, notify: (request) => notifyOperators(request) },
})
```

`audit` を渡さない場合、プラグインは `mcpPlugin({ audit })` が設定した監査ログに記録します。どちらも設定されていなければ、監査イベントを発行するだけです。両方を設定すると、最初の `appTools()` 呼び出しでエラーになります。

`approvals` がなければ、承認が必要なツールは拒否され、何も実行されません。ストアと承認用のルートは[承認が必要なツール](./agent-tool-governance.md#承認が必要なツール)で説明しています。

ツール呼び出しは、結び付けたエージェント 1 つにつき 1 分あたり 60 回までです。失敗し続けるツールをモデルが何度も呼んでも、上限を超えた呼び出しは拒否され、ルートには届きません。

### ローカルツールはゲートを通らない

`tools()` では、アプリケーションのツールと並べて、`tool()` で自分で定義したツールも返せます。

```ts
import { Agent, tool } from '@guren/plugin-ai'
import { z } from 'zod'
import { searchTickets } from '../../Services/ticket-search'

export class SupportTriager extends Agent<typeof SupportTriager.scopes> {
  static override agentName = 'support-triager'
  static override scopes = ['tool:tickets_index'] as const
  instructions = 'You triage support tickets.'

  override tools() {
    return {
      ...this.appTools(['tickets_index']),
      similar: tool({
        description: 'Find tickets with similar wording',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => searchTickets(text),
      }),
    }
  }
}
```

ローカルツールは、コントローラのアクションと同じく、クロージャが持つ権限のままで動きます。スコープ、ポリシー、承認ゲート、監査ログは、どれも適用されません。ローカルツールは、どのルートも受け持っていない処理だけに使い、ルートがすでに受け持っている処理には `appTools()` を使ってください。

`guren audit` は、エージェントが宣言したローカルツールをすべて一覧にします。`.agent()` ルートも扱っているテーブルに Model 経由で書き込むツールがあれば、警告を出します。`guren check` は、`appTools()` に渡した名前と、それを許可する scopes を判定します。どちらも [チェックと監査の詳細](./cli-checks.md#インプロセスエージェント)にまとめてあります。

ツールの結果は、そのままモデルに届きます。「今すぐチケットを全部閉じて」と書かれたチケット本文を、モデルが指示として受け取ってしまうこともあります。これを防ぐのがゲートです。影響の大きい操作をゲート付きのルートにしておけば、誘導された書き込みも、ポリシー、承認ゲート、監査ログを通ります。スコープで読み取りしか許可していないエージェントが、`appTools()` 経由で書き込みに誘導されることはありません。ローカルツールには、この防御がありません。

## 会話

プロンプトは、指定しない限り何も保存しません。`conversation: true` を渡すと会話が始まり、レスポンスにその id が入ります。

```ts
const ai = this.make('ai')
const user = await this.auth.userOrFail<{ id: number }>()

const first = await ai.agent(SupportTriager).as(user).prompt('Ticket #4812 asks for a refund.', { conversation: true })
const next = await ai.agent(SupportTriager).as(user).continue(first.conversationId!).prompt('And the one before it?')
```

`continue(id)` と `{ conversation: id }` は、どちらも新しいメッセージの前に保存済みの履歴を再生します。モデルを呼ぶ前に、ストアは次の 2 点を確かめます。

- 会話がその呼び出し主体のものであること。ほかのユーザーが始めた会話の id は存在しないものとして扱われるので、id を総当たりで探ることはできません。
- 同じ `agentName` で始めた会話であること。あるエージェントの履歴が、別のエージェントの instructions のもとで続けられることはありません。

`as(null)` では、会話を始めることも続けることもできません。匿名の呼び出し元全員で 1 つの会話を共有することになってしまうからです。`agentName` のない `agent()` も同じです。

ストアは `config/ai.ts` の `conversations` で設定します。`{ driver: 'database', conversations, messages }` には、`guren add ai` が追加する 2 つのテーブルを指定します。`{ driver: 'memory' }` はテストと開発用で、会話をプロセスの中に保持します。

ストアを設定しないまま会話を求めたプロンプトは、モデルを呼ぶ前に失敗します。ターンはモデルが答えた後で保存されるので、失敗したプロンプトは行を残しません。

テーブルには、ユーザーのテキスト、ツールの引数、すべてのツールの結果が、モデルが見たとおりに残ります。伏せ字(redaction)にするのは監査ログだけで、この履歴はそのまま残します。id を伏せてしまうと、次のターンでその id を使った操作ができなくなるからです。2 つのテーブルは、どちらも機密データとして扱ってください。

## チャットをストリーミングする

`stream()` は `prompt()` と同じ引数を取り、`@ai-sdk/react` の `useChat` が読めるストリーミングの `Response` を返します。コントローラは、それをそのまま返します。

```ts
// app/Http/Controllers/SupportChatController.ts
import { Controller } from '@guren/core'
import { ChatTurnSchema } from '@guren/plugin-ai'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'
import { SupportTriager } from '../../Ai/Agents/SupportTriager'

const ChatPageQuerySchema = z.object({ conversation: z.string().min(1).optional() })

export default class SupportChatController extends Controller {
  async show() {
    const { conversation } = this.validateQuery(ChatPageQuerySchema)
    const user = await this.auth.userOrFail<{ id: number }>()
    const messages = conversation ? await this.make('ai').agent(SupportTriager).as(user).history(conversation) : null

    return this.inertia(pages.support.Chat, {
      conversationId: messages ? conversation! : null,
      messages: messages ?? [],
    })
  }

  async chat(): Promise<Response> {
    const { conversation, message } = await this.validateBody(ChatTurnSchema)
    const user = await this.auth.userOrFail<{ id: number }>()

    return this.make('ai')
      .agent(SupportTriager)
      .as(user)
      .stream(message, { conversation: conversation ?? true, signal: this.request.raw.signal })
  }
}
```

`show()` はチャットのページを返します。`history(id)` は保存済みの会話を `useChat` のメッセージに変換して返し、そのときの確認は `continue()` と同じ 2 つです。ほかのユーザーが始めた会話や、別のエージェントの会話を指す id には、存在しない id と同じく `null` が返るので、ページはエラーにならずに空のチャットを開きます。ツール呼び出しは結果と合わせて `tool-<name>` パーツになり、ストリーミング中と同じ形で表示されます。失敗したツールのエラー文も、ストリーミング中と同じく伏せられます。`toModelOutput` を定義したツールは、モデルが受け取った出力で戻ります。ほかの方法で読み出した履歴は、`@guren/plugin-ai` の `toUIMessages()` で同じように変換できます。

ページ側では、`@guren/plugin-ai/client` の `createChatTransport()` が 1 ターン分の `{ conversation, message }` だけを送り、それまでのやりとり全体は送りません。ブラウザから送られた記録を受け入れると、モデルやツールが「すでに言ったこと」をブラウザ側で捏造できてしまうため、履歴はサーバー側に置きます。

最初のターンでは `conversation: null` を送ります。コントローラが会話を始め、レスポンスの `X-Guren-Conversation` ヘッダでその id を返すので、トランスポートはそれを覚えておき、以降のターンで送ります。

トランスポートは `XSRF-TOKEN` クッキーを `X-XSRF-TOKEN` ヘッダに入れて送り返すので、ルートは CSRF 保護の内側に置いたままで構いません。

URL に `?conversation=<id>` が付いていれば、ページは保存済みの履歴から始まります。`useChat({ id, messages })` は履歴を表示するだけで、次のターンで送るのは `{ conversation, message }` だけです。トランスポートはマウントごとに一度だけ作るので、Inertia の遷移で別の会話を開いたときは `key` でチャットを作り直します。このページは新しい会話の id をトランスポートにしか持たないので、再読み込みすると空のチャットが開きます。`make:ai-agent --chat` が書き出すページ([後述](#チャットのページを生成する))は、id とターンを URL と Inertia の履歴にも記録するので、再読み込みでもブラウザの戻る操作でも会話に戻れます。最初のターンを止めたときや失敗したときも、トランスポートを作り直します。そのターンは何も保存していないのに、トランスポートはレスポンスが返した id をもう持っているからです。

```tsx
// resources/js/pages/support/Chat.tsx
import { useChat } from '@ai-sdk/react'
import { createChatTransport, type UIMessage } from '@guren/plugin-ai/client'
import { useState } from 'react'

interface Props {
  conversationId: string | null
  messages: UIMessage[]
}

export default function Chat(props: Props) {
  return <Conversation key={props.conversationId ?? 'new'} {...props} />
}

function Conversation({ conversationId, messages: initialMessages }: Props) {
  const [transport] = useState(() => createChatTransport('/support/chat', { conversation: conversationId }))
  const { messages, sendMessage } = useChat({ id: conversationId ?? undefined, messages: initialMessages, transport })
  const [draft, setDraft] = useState('')

  return (
    <form method="post" action="/support/chat" onSubmit={(event) => { event.preventDefault(); void sendMessage({ text: draft }); setDraft('') }}>
      {messages.map((message) => (
        <p key={message.id}>
          {message.role}: {message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')}
        </p>
      ))}
      <input value={draft} onChange={(event) => setDraft(event.target.value)} />
    </form>
  )
}
```

`useChat` を使うには、`ai` 7 と対になる `@ai-sdk/react` 4.x をアプリにインストールしてください。履歴をサーバー側に置くため、次の 3 つの制約があります。

- チャットには会話ストアが必要です。状態を持たない形では使えません。
- `output` を宣言したエージェントはストリーミングできません。JSON がただのテキストとしてチャットに届いてしまうからです。そのエージェントには `prompt()` を使ってください。
- トランスポートは、メッセージの再生成と、ファイルを添付したユーザーメッセージを受け付けません。

`signal` で中断したリクエストは、何も保存しません。回答のストリーミングが始まった後で保存に失敗した場合は、ステータスコードをもう送ってしまっているので、ログに記録されます。

### チャットのページを生成する

`make:ai-agent --chat` を使うと、ここまでの内容を新しいエージェント用にまとめて書き出せます。

```bash
bunx guren make:ai-agent SupportBot --chat
```

エージェントのほかに、`show()` と `chat()` を持つ `SupportBotChatController`、ログインを必須にした `GET` と `POST /support-bot/chat`（名前はリソースと重ならない `support-bot.chat` と `support-bot.send`）を登録する `routes/support-bot-chat.ts`（`routes/web.ts` に組み込まれます）、ページの `resources/js/pages/support-bot/Chat.tsx` が書き出されます。ページが描画する `resources/js/components/ai/AgentChat.tsx` は、ストリーミング中の回答、停止ボタン、エラー、ツール呼び出しの入力と出力、再読み込み後に戻した履歴を表示します。見た目は Guren UI のトークンで整えてあり、`guren add ui` の `Alert`、`Button`、`Textarea` を使います。これらがアプリに無ければ、コマンドがコピーします。

`AgentChat.tsx` はアプリにコピーされ、その後はアプリのファイルとして扱います。2 つ目のエージェントに `--chat` を付けたときは既存のコピーをそのまま使い、`--force` を付けたときだけ置き換えます。`guren upgrade` は書き換えません。`@ai-sdk/react` が無いと表示されたら 4.x をインストールし、チャットには会話ストアが必要なので `config/ai.ts` に `conversations` を設定してください。このフラグは `--output` や `--module` と一緒には使えません。

## プロンプトをキューに入れる

`queue()` はキューのワーカーでプロンプトを実行し、モデルが答えると `AgentResponded` を発行します。

```ts
const run = await this.make('ai')
  .agent(SupportTriager)
  .as(user)
  .queue('Triage ticket #4812.', { conversation: true, queue: 'agents' })
// run.jobId, and run.conversationId when the call started or continued one
```

必要な設定は次の 3 つです。

- 名前によるエージェントの登録: `aiPlugin({ agents: [SupportTriager] })`。ワーカーはクラス名ではなく `agentName` からクラスを解決します。1 つの名前に 2 つのクラスを登録すると、起動時にエラーになります。
- `queue` のバインディング(`QueueServiceProvider`)とワーカー(`bunx guren queue:work`)。
- イベントのための `EventServiceProvider`。

```ts
import { AgentResponded } from '@guren/plugin-ai'

events.on(AgentResponded, async (event) => {
  // event.agentName, event.principal, event.conversationId,
  // event.response: { text, output, usage, finishReason }
})
```

`conversation: true` を渡すとディスパッチの前に会話が作られるので、id はすぐに使えます。ワーカーは、常にその会話を続ける形で実行します。キューのリスナーはイベント全体をシリアライズするので、イベントのレスポンスには `steps` が入りません。

キューに入れた実行は 1 回しか試行されません。再試行すると、モデルがもう一度呼ばれ、すべてのツールがもう一度実行されてしまうからです。visibility timeout を持つドライバ(Redis、SQS)は、その時間を超えた実行を再配信します。そのため、このタイムアウトとワーカーの `--timeout` は、いちばん長い実行より長くしてください。

呼び出し主体は、abilities も含めて、キューに入れた時点のものが使われます。

### 実行をブロードキャストする

`broadcast()` は `queue()` と同じように実行をキューに入れますが、イベントを発行する代わりに、回答を[ブロードキャスト](./broadcasting.md)のチャンネルに流します。これで、バックグラウンドの実行の回答を、トークンが届くたびにページ側で表示できます。

```ts
const run = await this.make('ai')
  .agent(SupportTriager)
  .as(user)
  .broadcast('Triage ticket #4812.', `private-support.${user.id}`, { conversation: true })
```

ワーカーは、UI メッセージのチャンクを 1 つずつ `AgentChunk` イベントとして publish します。このイベント名は、サーバー側でもクライアント側でも `AGENT_CHUNK_EVENT` で参照できます。

```tsx
import { createUseChannel } from '@guren/inertia-client'
import { AGENT_CHUNK_EVENT } from '@guren/plugin-ai/client'
import { useEffect } from 'react'

const useChannel = createUseChannel()

export function TriageFeed({ userId }: { userId: number }) {
  const channel = useChannel(`private-support.${userId}`)
  useEffect(() => channel.on(AGENT_CHUNK_EVENT, (chunk) => {
    // one UIMessageChunk: text deltas, tool calls, then `finish`
  }), [channel])
  return null
}
```

上のキューの設定に加えて、`BroadcastServiceProvider` が必要です。動作について、次の 3 つの決まりがあります。

- **認可されるのは subscribe で、publish は認可されません。** チャンネルは authorizer 付きのプライベートチャンネルとして登録してください。そうしないと、subscribe した人なら誰でも会話の中身を読めてしまいます。
- **実行は必ずストリームを終わらせます。** 完了する前に失敗したジョブは `error` チャンクを 1 つ publish するので、subscriber が待ち続けることはありません。このチャンクによって、ストリームが閉じた時点でジョブは失敗になります。
- **`AgentResponded` は発行されません。** 実行の終わりは `finish` チャンクで分かるからです。`stream()` と同じく、`output` を宣言したエージェントは受け付けません。途中から subscribe した人は、それまでに publish された分を受け取れません。

## 埋め込みと画像

`embed()`、`embedMany()`、`image()` は AI SDK の呼び出しそのままで、モデルだけをプロバイダ名から解決します。解決のしかたは、エージェントが言語モデルを解決するときと同じです。まず `config/ai.ts` にファクトリを書いてください。`embeddingModel` を宣言していないプロバイダ (Anthropic は埋め込みモデルを提供していません) を指定するとエラーになり、そのプロバイダ名が示されます。

```ts
// config/ai.ts
import { defineAiConfig } from '@guren/plugin-ai'
import { createOpenAI } from '@ai-sdk/openai'

export default defineAiConfig((env) => {
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY })
  return {
    default: env.AI_PROVIDER,
    providers: {
      openai: {
        model: () => openai('gpt-5'),
        embeddingModel: () => openai.textEmbeddingModel('text-embedding-3-small'),
        imageModel: () => openai.imageModel('gpt-image-1'),
      },
    },
  }
})
```

```ts
import { embed, embedMany, image } from '@guren/plugin-ai'

const { embedding } = await embed({ value: ticket.body })
const { embeddings } = await embedMany({ values: chunks })
const { image: cover } = await image({ prompt: 'A red fox in snow', size: '1024x1024' })
```

AI SDK が受け取るオプション (`maxRetries`、`abortSignal`、`headers`、`providerOptions`、`n`、`size`、`aspectRatio`、`seed`) はそのまま渡され、戻り値も SDK のものがそのまま返ります。Guren が加えるオプションは次の 2 つだけです。

| オプション | 内容 |
|---|---|
| `provider` | `config/ai.ts` のプロバイダ名。省略すると `default` を使います。 |
| `manager` | モデルを解決するマネージャ。省略するとデフォルトアプリケーションの `ai` バインディングを使います。`Agent` の static メソッドと同じ動きです。1 つのプロセスで複数のアプリケーションを起動する場合は、コントローラから `this.make('ai')` を渡してください。 |

モデルを名前で解決するので、これらの呼び出しもテストで差し替えられる範囲に入ります。アプリケーションのコードはモデルを持たないため、`fakeAi()` はプロンプトと同じように `embed()` にも答えられます。

ベクトルをどこに保存するかは、アプリケーションで決めてください。`@guren/orm` にはベクトル型の列がないので、`pgvector` の列を使うには、今のところ手書きのマイグレーションと生のクエリが必要です。`result.image` は SDK の `GeneratedFile` (`base64`、`uint8Array`、`mediaType`) で、保存には[添付ファイル](./attachments.md)を使います。

## 評価

`evaluate()` は、ある 1 つの状態について型付きの質問を投げ、答えをテキストではなく確率で受け取ります。質問は、選択肢から 1 つ選ぶ `choice`、順序のある段階で採点する `score`、`boolean` の 3 種類です。中身は AI SDK の `experimental_evaluate` で、`embed()` と同じくモデルだけをプロバイダ名から解決します。AI SDK はこの API を experimental としていて、patch リリースで変わることがありますが、プラグインはそれに追随します。

モデルは `config/ai.ts` の `evaluationModel` ファクトリから取り出します。Jev(TypeSafe AI)のように何も生成しないモデルもあるので、このエントリでは `model` を省略できます。

`defaultEvaluation` には、`evaluate()` でプロバイダを指定しなかったときに使うエントリを書きます。省略すると `default` が使われます。すでに Vercel AI Gateway 経由でモデルを使っているアプリなら、同じモデルを `gateway.evaluationModel('typesafe-ai/jev')` で取り出せます。

```ts
// config/ai.ts
providers: {
  anthropic: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5-5') },
  typesafe: { evaluationModel: () => createTypeSafeAi({ apiKey: env.TYPESAFE_AI_API_KEY }).evaluationModel('jev-latest') },
},
defaultEvaluation: 'typesafe',
```

```ts
import { evaluate } from '@guren/plugin-ai'

const { answers } = await evaluate({
  manager: this.make('ai'),
  state: { title: ticket.title },
  questions: {
    category: {
      type: 'choice',
      instructions: 'Which team owns this ticket?',
      criteria: { billing: 'Charges and refunds', bug: 'Something is broken', account: null },
    },
    urgent: { type: 'boolean', instructions: 'Does this need a human within the hour?' },
  },
})
answers.category.choice        // 'billing' | 'bug' | 'account'
answers.category.probabilities // { billing: 0.93, bug: 0.05, account: 0.02 }
answers.urgent.probability     // 0.37
```

`provider` と `manager` の解決のしかたは `embed()` と同じです。`choice` の答えは `criteria` のキーのどれかになるので、選択肢をデータベースの enum から読めば、答えはそのまま列の型になります。

確率は順位の目安として扱い、そのままの割合とは受け取らないでください。公開されている意図分類のデータセットで測ったところ、Jev の確率はどのビンでも実際の的中率より高く出ていました。答えをそのまま採用するしきい値は、手元のデータのラベル付きサンプルを使い、必要な precision から決めてください。[`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents) はこの形でチケットを振り分けていて、計測の結果を README に載せています。

## テスト

`@guren/testing` の `app.fakeAi()` を使うと、テストの中でモデルの応答をスクリプトで決められます。そのあいだも、エージェントのツールは実際のルートにディスパッチされます。実際のモデルでケースを流して採点するには `guren ai:eval` を使います。どちらも [AI エージェントのテスト](./ai-agents-testing.md)で説明します。

## 未提供の機能

設計にはあるものの、次の機能はまだリリースされていません。

- `make:ai-tool` と、プロバイダ名・エージェント名の型付け
- `guren add ai --provider typesafe` のテンプレートと、評価の質問の雛形生成。それまでは `evaluationModel` のエントリを手で書いてください

## 関連

- [エージェントインターフェース](./agent-interface.md): `.agent()` ルートとツールの導出
- [AI エージェントのテスト](./ai-agents-testing.md): テストでの `fakeAi()` と、実際のモデルで行う eval
- [エージェントツールの権限と監査](./agent-tool-governance.md): スコープ、承認、監査ログ
- [永続エージェント](./durable-agents.md): Cloudflare Workers で長命なエージェントをホストする
- [キュー](./queue.md)と[イベント](./events.md): キューに入れたプロンプトが使うワーカーとリスナー
- [CLI](./cli.md): `add ai`、`make:ai-agent`、`codegen`
- [RFC 0029: In-Process AI Agents](https://github.com/gurenjs/guren/blob/main/rfcs/0029-in-process-ai-agents.md): 設計と、リリースした挙動が設計と異なる箇所のすべて
- [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents): `TicketDigest`、そのルート、`fakeAi()` のテスト
