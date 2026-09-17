# AI エージェント

AI エージェントは、アプリケーション内で言語モデルを呼び出すクラスです。アプリケーションへは、ルートがすでに宣言しているエージェントツールを通してしか到達しません。`@guren/plugin-ai` は [Vercel AI SDK](https://ai-sdk.dev) の上に作られています。プロバイダとの通信は SDK が受け持ち、モデルがどのルートを誰として呼べるか、何を記録するかはプラグインが決めます。

エージェントに関するガイドは3つあり、それぞれが1つの問いに答えます。

| ガイド | 問い |
|---|---|
| [エージェントインターフェース](./agent-interface.md) | エージェントはこのアプリケーションに何ができるか(`.agent()` ルート、スコープ、承認、監査) |
| AI エージェント(このガイド) | アプリケーションのコードから、そのツールを使う仕事をどうモデルに頼むか |
| [永続エージェント](./durable-agents.md) | 自分の state とスケジュールを持つ長命なエージェントをどこで動かすか |

このガイドのエージェントは、それを呼び出したリクエスト・ジョブ・コマンドの中で動きます。呼び出しをまたいで残るのは、保存を頼んだ会話履歴だけです。永続エージェントがモデルを呼ぶときに、このエージェントを使うこともできます。

## インストール

```bash
bunx guren add ai
```

このコマンドには `config/env.ts` が必要です([設定](./configuration.md)を参照)。書き込む内容は次のとおりです。

- 1つのプロバイダ用の `config/ai.ts`。`--provider anthropic`(既定)、`openai`、`gateway` から選びます。
- プロバイダの API キーを `config/env.ts`、`.env.example`、`.env` に追加します。キーは optional かつ secret として宣言されます。キーがなくてもアプリは起動し、最初のプロンプトがキー名を示して失敗します。
- `createApp({ config })` への `config/ai.ts` の登録と、`createApp({ providers })` への `aiPlugin()` の登録。
- `db/schema.ts` を持つアプリでは、`ai_conversations` と `ai_messages` のテーブル、そのマイグレーション、`config/ai.ts` の `conversations` 設定。`--no-conversations` を付けると3つとも省きます。

最後に `bun add @guren/plugin-ai ai <プロバイダのパッケージ>` を実行します。`--no-install` を付けると、実行せずにコマンドを表示します。プラグインの動作には Node 22 以降か Bun が必要です。

Anthropic を選んだときに生成される設定です。

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
        return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5')
      },
    },
  },
  conversations: { driver: 'database', conversations: aiConversations, messages: aiMessages },
}))
```

`model` の中のガードは消さないでください。検証済みの env は `process.env` にコピーされないので、キーは明示的に渡します。キーを渡さないとプロバイダのパッケージが自分で `process.env` を読み、空の `ANTHROPIC_API_KEY=` 行が本物のキーとして API に送られます。

`providers` は名前からファクトリへの対応表です。各ファクトリは、その名前を使う最初のプロンプトで1度だけ実行され、結果はメモ化されます。エージェントが指定するのはプロバイダの名前で、モデルのインスタンスは持ちません。テスト用の fake がアプリケーションから到達できるすべてのモデルを差し替えられるのはこのためです。2つ目のプロバイダを追加するには、そのパッケージをインストールしてエントリを足します。

```ts
providers: {
  anthropic: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5') },
  fast: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-haiku-4-5') },
},
```

`default` はエントリのどれかを指している必要があり、そうでなければ起動が失敗します。エントリには `embeddingModel` と `imageModel` のファクトリも書けます。今のところプラグイン側でこれを使うのは `ai.embeddingModel(name)` だけで、AI SDK の `embed()` を自分で呼ぶコードに埋め込みモデルを返します。

## エージェントを書く

```bash
bunx guren make:ai-agent TicketDigest --tools tickets_index --output --test
```

`--tools` は、何かを書き込む前に、各名前がルートから導出されるツールに存在するかを確認します。`--output` は構造化出力のスキーマを、`--test` はモデルをスクリプト化するテストを追加します。`--module <name>` を付けるとモジュールの中に書き込みます。[永続エージェント](./durable-agents.md)を生成する `make:agent` とは別のコマンドです。

[`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents) のエージェントを短くしたものです。

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
| `tools()` | モデルが呼べるツール。principal が決まったあとに実行されるので、メソッドです。 | `{}` |
| `output` | パース済みで型の付いた結果を得る `Output.object({ schema })`。 | テキスト |
| `stopWhen` | ツールループを止める条件。例: `stepCountIs(5)`。 | 20ステップ |
| `static agentName` | fake・監査ログ・キュー実行が使う名前。 | クラス名 |
| `static scopes` | `appTools()` がモデルに渡してよいアプリケーションのツール。 | `[]` |

`agentName` は固定してください。既定値のクラス名は、識別子を短縮するバンドラに書き換えられます。そうなると、名前が変わる前にキューに入った実行や保存済みの会話が解決できなくなります。

`Agent`、`Output`、`tool`、`stepCountIs` はすべて `@guren/plugin-ai` から export されているので、エージェントのファイルが import するパッケージは1つで済みます。

### プロンプトを送る

コントローラ・ジョブ・コマンドの中では、コンテナから `ai` マネージャを取り出し、エージェントを principal に結び付けてからプロンプトを送ります。

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

`response` には `text`、`output`(クラスの `output` スキーマから型が付きます。宣言がなければテキスト)、`steps`(ツール呼び出しを含む AI SDK のステップ)、全ステップを合計した `usage`、`finishReason` が入ります。結果が重要な場面では `finishReason` を確認してください。`'length'` はモデルがトークンを使い切ったことを示し、出力は途中で切れています。

`userOrFail()` には `id` を持つ型引数を渡してください。型引数がないと `Authenticatable` が返り、`as()` はそれを受け付けません。

コンテナが手元にないコードでは、`TicketDigest.as(user).prompt(...)` が既定のアプリケーション経由で同じことをします。`TicketDigest.prompt(input)` は `as(null).prompt(input)` と同じです。単発の呼び出しには、`agent({ instructions, agentName, scopes, tools })` が無名のエージェントクラスを返します。

### principal

`as(principal)` は、結び付けたエージェントのすべてのツール呼び出しで、モデルが誰として振る舞うかを固定します。受け付けるのはユーザーのレコード、`AgentPrincipal`(`{ kind: 'user' | 'service', id, abilities? }`)、`null` です。保持されるのは `kind`、`id`、`abilities` だけです。ツール呼び出しはリクエストとしてルートに届き、ルートは設定済みのユーザープロバイダでユーザーを組み立て直します。渡したオブジェクトにロールやテナントのフィールドがあっても、ポリシーには届きません。

principal が `abilities` を持つ場合、エージェントが得るツールは、クラスの `scopes` とその abilities の両方が許可するツールに絞られます。呼び出し側の同意はエージェントを狭めることはあっても、広げることはありません。

`as(null)` は匿名の実行で、誰かが起動したわけではない処理(定期的な要約など)に使います。このとき `appTools()` が受け付けるのは、ルートが read-only と宣言されているツールだけです。渡した名前のうちこれを満たさないものは、すべて構築時のエラーに名前が挙がります。匿名のリクエストには、書き込みを認可したり承認したりする対象の identity がありません。そのため、ツールを1回ずつ呼んで拒否されるのではなく、エージェントを組み立てる時点で拒否されます。

## アプリケーションのツール

`this.appTools(names)` は、`.agent()` ルートから組み立てたツールをモデルに渡します。どの呼び出しも、MCP エンドポイント、`guren tool:call` コマンド、永続エージェントと同じ invocation パイプラインを通ります。

1. スコープゲートが、ツールをエージェントの `scopes` と照合します。
2. 呼び出しは principal を載せたルートへのリクエストになり、`requireAuthenticated()`、`this.auth`、ポリシーがそのユーザーについて判定します。
3. `approval: 'required'` を宣言したツールは、承認ゲートが止めます。
4. 呼び出しは `surface: 'in-process'` として監査ログに記録され、引数は redact されます。

スキーマや認可ルールを2つ目として書く必要はありません。ツールの説明、入力スキーマ、出力は、[エージェントインターフェース](./agent-interface.md#メタデータのフィールド)にあるとおりルートから導出されます。

### スコープ

`static scopes` の文法はトークンのスコープと同じです。

| スコープ | 許可するもの |
|---|---|
| `tool:tickets_index` | そのツール1つ |
| `tools:tickets.*` | 名前が `tickets.` で始まるすべてのツール |
| `tools:read` | read-only のすべてのツール |
| `tools:*` | すべてのツール |

`tool:` の形を優先してください。プレフィックスや `tools:read` の許可は、該当するルートに `.agent()` が付くたびに黙って広がります。プレフィックスはドットまでしか一致しないので、`tools:tickets.*` は移植性のある名前 `tickets_index` を付けたツールには届きません(後述)。

名前に一致するルートがない、`scopes` がその名前を許可していない、`scopes` の要素が文法から外れている、`as(null)` の実行で read-only でないツールを指定した。このいずれかに当たると、`appTools()` は構築を拒否し、問題をすべて並べた1つのエラーを出します。エラーは `as()` の時点で出るので、設定を誤ったエージェントは最初のテストで失敗します。モデルが見つけられないツールを抱えたまま動き出すことはありません。

### ツール名の型

`bunx guren codegen` を実行すると、プラグインに依存するアプリでは `.guren/agents.gen.ts` が `appTools()` に型を付けます。どのルートからも導出されない名前はコンパイルエラーになり、各ツールの入力と結果にはルートの契約から型が付きます。`scopes` を `as const` で宣言し、`extends Agent<typeof TicketDigest.scopes>` と書くと、どの `tool:` 要素にも許可されていない名前もコンパイルエラーになります。型パラメータを書かなければ、コンパイル時に確認されるのは名前だけです。プレフィックスによる許可は `as()` の実行時に確認されます。

### モデルが受け取る結果

ツールの結果は次の3つの形のどれかです。

- 成功したときは、ルートのレスポンスボディ。
- ルートがエラーのステータスを返したとき(検証の 422、ポリシーの 403 など)は `{ error: true, status, body }`。
- ゲートが拒否して何も実行されなかったときは `{ denied, message, approval? }`。承認が必要なツールでは、`approval` に保留中のリクエスト(`status`、`requestId`、`expiresAt`)が入るので、モデルは承認待ちであることをユーザーに伝えられます。

ディスパッチそのものが失敗した場合(アプリが起動できなかったなど)はツールの中で例外になり、AI SDK がツールのエラーとしてモデルに伝えます。

### ツール名はそのままプロバイダに届く

Anthropic と OpenAI が受け付けるツール名は `[A-Za-z0-9_-]{1,64}` に一致するものだけです。`tickets.index` という名前のルートは API に拒否されるツールになり、`appTools()` はそれをパッケージするときに1度だけ警告します。ルートには移植性のあるツール名を付けてください。ルート名、`route()` ヘルパー、パスは変わりません。

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

`audit` を渡さない場合、プラグインは `mcpPlugin({ audit })` が設定した監査ログに記録し、どちらもなければ監査イベントを発行するだけです。両方を設定すると、最初の `appTools()` 呼び出しでエラーになります。`approvals` がなければ、承認が必要なツールは拒否され、何も実行されません。ストアと承認用のルートは[承認が必要なツール](./agent-interface.md#承認が必要なツール)で説明しています。

結び付けたエージェント1つにつき、ツール呼び出しは1分あたり60回までです。失敗し続けるツールをモデルが繰り返し呼んでも、上限を超えた呼び出しは拒否され、ルートには届きません。

### ローカルツールはゲートを通らない

`tools()` は、アプリケーションのツールと並べて、`tool()` で自分で定義したツールも返せます。

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

ローカルツールは、コントローラのアクションと同じく、クロージャが持つ権限でそのまま動きます。スコープ、ポリシー、承認ゲート、監査ログはどれも適用されません。ローカルツールはどのルートもしていない処理に限り、ルートがすでにしている処理には `appTools()` を使ってください。

ツールの結果はそのままモデルに届きます。「今すぐチケットを全部閉じて」と書かれたチケット本文は、モデルが従いうるテキストです。これに対する防御はゲートが担います。影響の大きい操作はゲート付きのルートにしておけば、誘導された書き込みもポリシー、承認ゲート、監査ログを通ります。スコープが読み取りしか許可していないエージェントは、`appTools()` 経由では書き込みに誘導されません。ローカルツールにはこの防御がありません。

## 会話

プロンプトは、頼まない限り何も保存しません。`conversation: true` を渡すと会話が始まり、レスポンスにその id が入ります。

```ts
const ai = this.make('ai')
const user = await this.auth.userOrFail<{ id: number }>()

const first = await ai.agent(SupportTriager).as(user).prompt('Ticket #4812 asks for a refund.', { conversation: true })
const next = await ai.agent(SupportTriager).as(user).continue(first.conversationId!).prompt('And the one before it?')
```

`continue(id)` と `{ conversation: id }` はどちらも、新しいメッセージの前に保存済みの履歴を再生します。モデルを呼ぶ前に、ストアが2つのことを確認します。

- 会話がその principal のものであること。他のユーザーが始めた会話の id は存在しないものとして扱われるので、id を総当たりで探ることはできません。
- 同じ `agentName` で始めた会話であること。あるエージェントの履歴が、別のエージェントの instructions のもとで続けられることはありません。

`as(null)` は会話を始めることも続けることもできません。匿名の呼び出し元全員が1つの会話を共有することになるからです。`agentName` のない `agent()` も同様です。

ストアは `config/ai.ts` の `conversations` で設定します。`{ driver: 'database', conversations, messages }` は `guren add ai` が追加する2つのテーブルを指定し、`{ driver: 'memory' }` はテストと開発用にプロセス内に保持します。ストアを設定せずに会話を求めたプロンプトは、モデルを呼ぶ前に失敗します。ターンが保存されるのはモデルが答えたあとなので、失敗したプロンプトは行を残しません。

テーブルには、モデルが見たとおりの記録が残ります。ユーザーのテキスト、ツールの引数、すべてのツールの結果です。redaction が適用されるのは監査ログで、この履歴には適用されません。マスクした id では次のターンで操作できないからです。2つのテーブルはどちらも機密データとして扱ってください。

## チャットをストリーミングする

`stream()` は `prompt()` と同じ引数を取り、`@ai-sdk/react` の `useChat` が読めるストリーミングの `Response` を返します。コントローラはそれをそのまま返します。

```ts
// app/Http/Controllers/SupportChatController.ts
import { Controller } from '@guren/core'
import { ChatTurnSchema } from '@guren/plugin-ai'
import { SupportTriager } from '../../Ai/Agents/SupportTriager'

export default class SupportChatController extends Controller {
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

ページ側では、`@guren/plugin-ai/client` の `createChatTransport()` が1ターン分の `{ conversation, message }` を送ります。これまでの記録全体は送りません。ブラウザが送る記録を受け入れると、モデルやツールが「すでに言ったこと」をブラウザが捏造できてしまうので、履歴はサーバー側に置きます。最初のターンは `conversation: null` を送り、コントローラが会話を始め、レスポンスの `X-Guren-Conversation` ヘッダでその id を返します。トランスポートはそれを保持して以降のターンで送ります。トランスポートは `XSRF-TOKEN` クッキーを `X-XSRF-TOKEN` ヘッダとして送り返すので、ルートは CSRF 保護の内側に置いたままにできます。

```tsx
import { useChat } from '@ai-sdk/react'
import { createChatTransport } from '@guren/plugin-ai/client'
import { useState } from 'react'

export default function SupportChat({ conversationId }: { conversationId: string | null }) {
  const [transport] = useState(() =>
    createChatTransport('/support/chat', {
      conversation: conversationId,
      onConversation: (id) => window.history.replaceState(null, '', `?conversation=${id}`),
    }))
  const { messages, sendMessage } = useChat({ transport })
  const [draft, setDraft] = useState('')

  return (
    <form onSubmit={(event) => { event.preventDefault(); void sendMessage({ text: draft }); setDraft('') }}>
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

`useChat` を使うには、`ai` 7 と対になる `@ai-sdk/react` 4.x をアプリにインストールしてください。履歴をサーバー側に置くことから、制約が4つあります。

- チャットには会話ストアが必要です。ステートレスな形はありません。
- `output` を宣言したエージェントはストリーミングできません。JSON がプレーンテキストとしてチャットに届いてしまうからです。そのエージェントには `prompt()` を使ってください。
- トランスポートは、メッセージの再生成と、ファイルを添付したユーザーメッセージを拒否します。
- プラグインは、保存済みの履歴を `useChat` のメッセージに戻す変換を持ちません。会話の途中でページを再読み込みすると、メッセージ一覧は空から始まり、サーバー側では同じ会話が続きます。

`signal` で中断したリクエストは何も保存しません。回答のストリーミングが始まったあとに保存が失敗した場合は、ステータスコードが送信済みなのでログに記録されます。

## プロンプトをキューに入れる

`queue()` はキューのワーカーでプロンプトを実行し、モデルが答えたら `AgentResponded` を発行します。

```ts
const run = await this.make('ai')
  .agent(SupportTriager)
  .as(user)
  .queue('Triage ticket #4812.', { conversation: true, queue: 'agents' })
// run.jobId, and run.conversationId when the call started or continued one
```

必要な配線は3つです。

- 名前によるエージェントの登録: `aiPlugin({ agents: [SupportTriager] })`。ワーカーはクラス名ではなく `agentName` からクラスを解決します。1つの名前に2つのクラスを登録すると、起動時に拒否されます。
- `queue` のバインディング(`QueueServiceProvider`)とワーカー(`bunx guren queue:work`)。
- イベントのための `EventServiceProvider`。

```ts
import { AgentResponded } from '@guren/plugin-ai'

events.on(AgentResponded, async (event) => {
  // event.agentName, event.principal, event.conversationId,
  // event.response: { text, output, usage, finishReason }
})
```

`conversation: true` はディスパッチの前に会話を作るので、id はすぐに使えます。ワーカーは常にその会話を続ける形で実行します。キューのリスナーはイベント全体をシリアライズするため、イベントのレスポンスには `steps` が入りません。

キューに入れた実行は1回だけ試行されます。再試行するとモデルがもう一度呼ばれ、すべてのツールがもう一度実行されるからです。visibility timeout を持つドライバ(Redis、SQS)は、その時間を超えた実行を再配信するので、そのタイムアウトとワーカーの `--timeout` は最も長い実行より長くしてください。principal は、abilities も含めて、キューに入れた時点のものが使われます。

## テスト

`@guren/testing` の `app.fakeAi()` は、`TestApp.fromApp(app)` で起動したアプリの `ai` バインディングを差し替えます。スクリプト化するのはモデルだけです。ツールはパイプラインを通ってルートにディスパッチされるので、テストでもスコープゲート、ポリシー、承認ゲートが実際に働きます。`examples/agents` のテストを短くしたものです。元のテストはチケットを先に作り、ツールが返した実際の答えにそのチケットが入っていることも確認します。

```ts
import { beforeAll, describe, expect, test } from 'bun:test'
import type { TestApp } from '@guren/testing'
import { TicketDigest } from '../app/Ai/Agents/TicketDigest'
import { operatorToken, testApp } from './support/app'

let http: TestApp
let bearer: string

beforeAll(async () => {
  http = await testApp() // TestApp.fromApp(app) over a migrated test database
  bearer = await operatorToken()
})

describe('TicketDigest', () => {
  test('should read tickets through the real route and answer with the scripted digest', async () => {
    using ai = http.fakeAi()
    ai.respond(TicketDigest, [
      {
        toolCalls: [{ name: 'tickets_index', input: { status: 'open' } }],
        then: { output: { summary: 'One printer fire.', staleTicketIds: [] } },
      },
    ])

    const body = await (
      await http.withHeaders({ Authorization: `Bearer ${bearer}` }).post('/ops/agents/digest', {}).assertOk()
    ).json<{ digest: { summary: string } }>()

    expect(body.digest.summary).toBe('One printer fire.')
    ai.assertPrompted(TicketDigest, (input) => input.startsWith('Today is '))
    expect(ai.calls(TicketDigest)[0]!.toolCalls[0]?.name).toBe('tickets_index')
  })
})
```

`@guren/plugin-ai` と並べて `ai` もインストールしてください。fake は AI SDK のモックモデルの上に作られています。

`respond(Agent, [...])` は、そのエージェントの今後のプロンプト1回につき1つずつ、スクリプト化した応答を積みます。

| 応答 | モデルの動き |
|---|---|
| `'text'` または `{ text }` | そのテキストで答える |
| `{ output }` | その値を構造化出力として答える |
| `{ toolCalls: [{ name, input }], then }` | それらのツール呼び出しを要求してから、`then` で答える |

`calls(Agent)` は、各プロンプトを `input`、`principal`、`response`、`toolCalls` とともに返します。各ツール呼び出しには、実際のツールが返した値か、投げたエラーが記録されます。`stream()` の呼び出しでは、テストがレスポンスボディを読み進めるにつれて `toolCalls` が埋まります。

プロンプトの確認には `assertPrompted(Agent, predicate?)`、`assertNotPrompted(Agent, predicate)`、`assertNeverPrompted(Agent)` を使います。スクリプトのないプロンプトは例外を投げ、`using` ブロックの終わりで fake を破棄するときにも、エージェント名を示してもう一度例外を投げます。ルートは最初のエラーを、中身の分からない 500 に変えてしまうことが多いからです。スクリプトの回答に届く前に(`stopWhen` によって)ループが止まった場合も、破棄が失敗します。

fake は `conversations()` に本物のストアで答えるので、`conversation: true` を付けたスクリプト化プロンプトは本番と同じ行を書き込みます。埋め込みモデルはスクリプト化しません。

fake が証明するのは配線です。instructions とツールの説明が本物のモデルから正しい答えを引き出せるかは、意図してコストをかけて測る別の計測で、このプラグインにはまだそれを実行する機能がありません。

## 未提供の機能

設計のうち、次の部分はまだ出荷されていません。

- `broadcast()`。キューに入れた実行の回答を[ブロードキャスト](./broadcasting.md)でストリーミングします。
- `embed()` と `image()` のラッパー。それまでは `ai.embeddingModel(name)` を使って AI SDK を呼んでください。
- 本物のモデルに対してエージェントを計測する `defineEval()` と `guren ai:eval`。
- エージェント向けの `guren check` と `guren audit` のルール。ローカルツールの一覧表示を含みます。
- `make:ai-tool` と、プロバイダ名・エージェント名の型付け。

## 関連

- [エージェントインターフェース](./agent-interface.md): `.agent()` ルート、ツールの導出、スコープ、承認、監査ログ
- [永続エージェント](./durable-agents.md): Cloudflare Workers で長命なエージェントをホストする
- [キュー](./queue.md)と[イベント](./events.md): キューに入れたプロンプトが使うワーカーとリスナー
- [CLI](./cli.md): `add ai`、`make:ai-agent`、`codegen`
- [RFC 0029: In-Process AI Agents](https://github.com/gurenjs/guren/blob/main/rfcs/0029-in-process-ai-agents.md): 設計と、出荷した挙動が設計と異なるすべての箇所
- [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents): `TicketDigest`、そのルート、`fakeAi()` のテスト
