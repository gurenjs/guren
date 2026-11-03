# AI エージェントのテスト

エージェントのテストには 2 つの段階があります。`fakeAi()` を使うテストでは、モデルの応答をスクリプトで決めますが、ツールは実際のルートを通って動きます。そのため、配線が正しいことをほかのテストと同じように `bun test` で確かめられます。eval は、用意したケースに対して実際のモデルでエージェントを動かし、結果を採点します。エージェントそのものの書き方は [AI エージェント](./ai-agents.md)で説明しています。

## `fakeAi()` でモデルの応答を決める

`@guren/testing` の `app.fakeAi()` は、`TestApp.fromApp(app)` で起動したアプリの `ai` バインディングを差し替えます。応答をスクリプトで決めるのはモデルだけです。ツールはパイプラインを通ってルートにディスパッチされるので、テストでもスコープゲート、ポリシー、承認ゲートが実際に働きます。

次の例は `examples/agents` のテストを短くしたものです。元のテストでは先にチケットを作り、ツールが返した実際の答えにそのチケットが入っていることも確かめています。

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

`@guren/plugin-ai` と一緒に `ai` もインストールしてください。フェイクは AI SDK のモックモデルの上に作られています。

`respond(Agent, [...])` は、そのエージェントに今後届くプロンプト 1 回につき 1 つずつ、あらかじめ決めた応答を積んでおきます。

| 応答 | モデルの動き |
|---|---|
| `'text'` または `{ text }` | そのテキストで答える |
| `{ output }` | その値を構造化出力として答える |
| `{ toolCalls: [{ name, input }], then }` | それらのツール呼び出しを要求してから、`then` で答える |

`calls(Agent)` は、各プロンプトを `input`、`principal`、`response`、`toolCalls` と一緒に返します。各ツール呼び出しには、実際のツールが返した値か、投げたエラーが記録されます。`stream()` の呼び出しでは、テストがレスポンスボディを読み進めるのに合わせて `toolCalls` が埋まっていきます。

プロンプトを確かめるには、`assertPrompted(Agent, predicate?)`、`assertNotPrompted(Agent, predicate)`、`assertNeverPrompted(Agent)` を使います。

応答を決めていないプロンプトは例外を投げます。さらに、`using` ブロックの終わりでフェイクを破棄するときにも、エージェント名を示してもう一度例外を投げます。ルートは最初のエラーを、中身の分からない 500 に変えてしまうことが多いからです。決めておいた回答に届く前に(`stopWhen` によって)ループが止まった場合も、破棄が失敗します。

フェイクは `conversations()` に本物のストアで答えるので、`conversation: true` を付けたプロンプトは、応答を決めてあっても本番と同じ行を書き込みます。
残る 2 つの呼び出しは、`respondEmbeddings()` と `respondImages()` で応答を決めます。

```ts
using ai = app.fakeAi()
ai.respondEmbeddings([[0.1, 0.2], [0.3, 0.4]])   // 値1つにつきベクトル1つ
ai.respondImages(['<base64>', ['<base64>', '<base64>']])   // image() の呼び出し1回につき1エントリ
```

ベクトルの配列は**値**ごとに 1 つずつ取り出されるので、`embedMany(['a', 'b'])` は、SDK がどうバッチにまとめても 2 つ消費します。関数 (`(value) => number[]`) を渡すと、どの値にも答えるので尽きることがありません。

`embedCalls()` と `imageCalls()` は各呼び出しの内容を返します。`assertEmbedded(predicate?)`、`assertNeverEmbedded()`、`assertGeneratedImage(predicate?)`、`assertNeverGeneratedImage()` は、プロンプト用のアサーションに相当するものです。

応答を決めていない `embed()` や `image()` は、応答を決めていないプロンプトと同じく、呼び出しと破棄の両方で失敗します。`config/ai.ts` のエントリがその種類のモデルを宣言していないプロバイダでも同じです。

`respondEvaluations([...])` は、今後の `evaluate()` 1 回につき 1 つずつ、答えの組を積んでおきます。質問ごとに値を 1 つ書きます。

```ts
ai.respondEvaluations([{ category: 'billing', urgent: 0.97 }])
```

| 値 | 答え |
|---|---|
| `choice` に文字列 | その選択肢が確率 1、他は 0 |
| `boolean` に数値 | その確率 |
| `score` に数値 | その位置。整数なら one-hot の分布も付く |
| AI SDK の answer オブジェクト | そのまま通す |

値は、消費されるときに質問と照らし合わされます。選択肢にない choice、段階数を超える score、0〜1 の範囲外の確率を書くと、呼び出しと破棄の両方が失敗します。本物のモデルが返せない値を、フェイクが返すことはありません。応答を決めたモデルは本物の `experimental_evaluate` の下で動くので、SDK 自身の検証も働きます。

`evaluationCalls()` は各呼び出しの `state`、`questions`、`provider`、`answers` を返します。`assertEvaluated(predicate?)` と `assertNeverEvaluated()` は、プロンプト用のアサーションに相当するものです。

フェイクで確かめられるのは配線までです。instructions とツールの説明で本物のモデルから正しい答えを引き出せるかどうかは、実際にモデルを呼ぶ、もう 1 つの計測で確かめます。

## Evals

eval は、用意したケースの集まりで本物のモデルを相手にエージェントを動かし、その結果を採点します。費用がかかり、結果も毎回同じとは限らないので、明示的に実行したときだけ動きます。`guren check` や `guren gate` が eval を走らせることはなく、テストファイルのフェイクの代わりになるものでもありません。

eval のファイルには、エージェント、ケースごとの使い捨てのアプリ、ケース、採点関数、そして採点が返す指標を書きます。

```ts
// tests/evals/ticket-digest.eval.ts
import { defineEval, fromJsonl, type EvalCase } from '@guren/plugin-ai/eval'
import { TicketDigest } from '../../app/Ai/Agents/TicketDigest'
import { Ticket } from '../../app/Models/Ticket'
import app from '../../src/app'

type DigestCase = EvalCase<{ staleIds: number[] }, Array<{ id: number; title: string; createdAt: string }>>

export default defineEval({
  agent: TicketDigest,
  app: async () => {
    await app.boot()
    return app
  },
  cases: fromJsonl<DigestCase>('tests/evals/ticket-digest/cases.jsonl'),
  as: () => ({ id: 1 }),
  setup: async (_app, kase) => {
    for (const seed of kase.seed ?? []) {
      await Ticket.create({ ...seed, status: 'open', createdAt: new Date(seed.createdAt), updatedAt: new Date() })
    }
  },
  grade: ({ response, expected }) => {
    const found = response.output.staleTicketIds
    const wanted = expected?.staleIds ?? []
    return { stale: found.length === wanted.length && wanted.every((id) => found.includes(id)) ? 1 : 0 }
  },
  metrics: [{ id: 'stale', kind: 'binary' }],
})
```

ケースごとに新しいアプリが用意されるので、エージェントの `appTools()` は本番と同じようにパイプラインを通ります。`grade()` は会話の記録ではなく、ツールが実行された後の最終状態を読みます。プログラムで採点できないものは、`judge` に指定した 2 つ目のエージェントに、別のプロバイダで採点させられます。judge の費用は別に記録されるので、比較する版(variant)どうしの差がぼやけることはありません。

ケースは 1 行に 1 つの JSON オブジェクトで書き、`id` と `input` は必須です。`expected`・`seed`・`tags` は、採点や `setup()` が読む分だけ書きます。

```bash
bunx guren ai:eval ticket-digest --dry-run                  # resolve the cases, call no model, write nothing
bunx guren ai:eval ticket-digest --reps 2 --max-cost-usd 5  # the baseline
bunx guren ai:eval ticket-digest --variant v1 --cases 20    # one round against it
```

`--concurrency` を付けると、ケースを並行して走らせます。flow 名から見つけられない eval は `--file` と `--dir` で指定します。`--json` を付けると、スクリプトで読みやすい形でサマリを出力します。

結果は `.claude/hillclimb/<flow>/<variant>/` に書き出されます。中身は、ケースと繰り返しごとの行、実行ごとのトレース、サマリ、そして採点できなかった試行を失敗の種類と一緒に記録する別ファイル(sidecar)です。Guren が書き出すのはデータだけで、ビューアは付いていません。このレイアウトは claude-api ハーネスのレポートビルダーが読む形で、`defineEval({ reporter })` で別の形に差し替えられます。

サマリでは、次の 3 点に気を付けています。

- **費用は、レスポンス自身の usage** と `config/ai.ts` のプロバイダの `pricing` から計算します。`perThousandRequests` に値段があれば、サーバー側のツール呼び出しも含めます。`pricing` のないプロバイダでは、行の費用は 0 ではなく未記録になり、`--max-cost-usd` が効かないことも報告されます。
- **途中で切れた回答**(`finishReason` が `'length'`)は、どの指標の平均からも外し、別に件数を数えます。途中で打ち切られる回答が増えた版のほうが良く見える、ということは起きません。
- **`--max-cost-usd` は厳密な上限ではありません。** 計算した費用が上限を超えると新しいケースは始まりませんが、実行中のケースは最後まで走ります。
