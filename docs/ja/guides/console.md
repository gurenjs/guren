# コンソールコマンド

コンソールコマンドを使うと、バックフィルや単発のメンテナンス、レポート生成といった処理をターミナルから実行できます。コマンドの中でも、HTTP ハンドラと同じモデル、サービス、コンテナをそのまま使えます。

コマンドは 1 つのクラスとして書きます。そのクラスをカーネルに集めておくと、カーネルが `argv` を見て該当するコマンドに処理を振り分けます。コマンドもカーネルもアプリケーション側のコードなので、登録するまでコマンドは動きません。

> フレームワークの対話型 REPL である `bunx guren console` とは別のものです。REPL については [CLI リファレンス](./cli.md#対話-repl) を参照してください。このガイドでは、**アプリケーションが定義する**コマンドを扱います。

## コマンドを定義する

コマンドは CLI で生成します。

```bash
bunx guren make:command SendDigest
```

実行すると `app/Console/Commands/SendDigestCommand.ts` が作られます。

```ts
import { Command } from '@guren/core'

export default class SendDigestCommand extends Command {
  static signature = 'send-digest'
  static description = 'Command description'

  async handle(): Promise<void> {
    this.info('Done!')
  }
}
```

コマンドに必要なのは、static プロパティ 2 つとメソッド 1 つだけです。

- `static signature`: コマンド名と、その引数やオプション（後述）。
- `static description`: `list` や `help` に表示する 1 行の説明。
- `handle()`: 実際の処理。成功したときは何も返さない（または `0` を返す）ようにし、失敗したときは 0 以外の数値を返すと、それが終了コードになります。捕捉されなかった例外は `this.error()` で報告され、終了コードは `1` になります。

コマンド名は kebab-case の名前が既定になります。別の名前で呼び出したい場合は `--command` を渡してください。

```bash
bunx guren make:command SendDigest --command reports:digest
```

## シグネチャの構文

```ts
static signature = 'users:create {email} {name?} {--admin} {--role=member}'
```

| トークン | 意味 |
|-------|---------|
| `{name}` | 必須の引数 |
| `{name?}` | 省略可能な引数 |
| `{name=default}` | 既定値を持つ引数 |
| `{name*}` | 配列引数。残りの引数をすべて受け取るので、最後に置く |
| `{--flag}` | 真偽値オプション。指定しなければ `false` |
| `{--opt=}` | 値を取るオプション |
| `{--opt=default}` | 既定値を持つオプション |
| `{-o\|--opt}` | 短縮形を持つオプション |
| `{--opt=*}` | 繰り返し指定できるオプション |

どのトークンにも、` : ` に続けて説明を書けます。書いた説明は、`help <command>` の出力で該当する引数やオプションの横に表示されます。

```ts
static signature = 'users:create {email : 招待するアドレス} {--admin : 管理者権限を付与}'
```

`{...}` の外にある文字列は無視されます。シグネチャの中で `{...}` に囲まずに書けるのはコマンド名だけです。

パースされた値は `handle()` の中で読み取ります。

```ts
async handle(): Promise<number | void> {
  const email = this.argument('email')
  const isAdmin = this.option<boolean>('admin')
  const role = this.option('role', 'member')

  if (!email) {
    this.error('An email address is required.')
    return 1
  }
}
```

必須の引数が省略されても、パーサはエラーにせず、`argument()` が `undefined` を返すだけです。必須にしたい値は自分で検証してください。真偽値オプションは必ず値を持ちます（フラグがなければ `false`）。

## 出力

コマンドの出力は `this.output` を通して行います。よく使う出力にはクラスにショートハンドがあります。

```ts
this.info('Starting the backfill')     // INFO  …
this.success('Backfill complete')      // DONE  …
this.warn('3 rows were skipped')       // WARN  …
this.error('Could not reach the API')  // ERROR … (stderr)
this.line('plain, unprefixed text')
this.newLine()

this.table(['ID', 'Email'], rows)
```

時間のかかる処理には `withProgress()` を使うと、要素を 1 つずつ処理しながらプログレスバーを表示できます。

```ts
await this.withProgress(users, async (user) => {
  await sendDigest(user)
})
```

## 対話的な入力

人が手で実行するコマンドなら、実行中に質問して入力を受け取れます。

```ts
const name = await this.ask('Project name?', 'my-app')
const proceed = await this.confirm('Drop the staging database?')
const env = await this.choice('Target environment', ['staging', 'production'])
const token = await this.secret('API token')
```

どれも標準入力から読み取ります。同じコマンドを CI やスケジューラのように人がいない環境でも動かすなら、`--force` のようなオプションを用意して、質問を飛ばせるようにしてください。

回答の前に標準入力が閉じた場合、`ask()`、`confirm()`、`choice()` は渡した既定値を返します。`secret()` だけは例外を投げます。パスワードには安全な既定値がないからです。末尾に改行がないまま終わった入力も、回答として扱います。

## コマンドを登録する

`app/Console/Commands` を自動でスキャンする仕組みはないので、生成したコマンドはカーネルに登録するまで一度も実行されません。デプロイがファイルシステムの glob に左右されないよう、あえてこうしています。

登録先として、雛形のアプリには `src/console.ts` が用意されています。`bunx guren make:command` を実行すると、生成したコマンドの import と登録がこのファイルに自動で追記されます。

```ts
import { ConsoleKernel } from '@guren/core'
import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'
import app from './app.js'

export const kernel = new ConsoleKernel({ container: app.container })

kernel.registerMany([SendDigestCommand])
```

`app.container` を渡しておくと、コマンドの中で `this.resolve()` を使ってサービスを解決できます。登録するクラスが 1 つなら、`register(OneCommand)` と書いても同じです。

このファイルができる前に作ったプロジェクトでは、自分で作成してください。デプロイ用のレシピはこの名前で import するので、**エクスポート名は必ず `kernel`** にします。`make:command` がこのファイルに自動で追記できなかったときは、追加すべき行がそのまま表示されます。

登録は明示的に行うものなので、どのコンソールのエントリポイントからも使われていないコマンドクラスがあると、`bunx guren check` が警告を出します。

```
⚠ SendDigestCommand registration: src/console.ts never uses SendDigestCommand
  outside its imports, so no kernel receives it.
```

import が残っているだけでは、登録済みとは見なしません。登録の行を消して import だけを消し忘れた状態こそ、この警告で見つけたいものだからです。

## コマンドを実行する

`bin/console.ts` がアプリケーションを起動してから、`argv` をカーネルに渡します。

```ts
import { ready } from '../src/main.js'
import { kernel } from '../src/console.js'

await ready

process.exit(await kernel.handle(process.argv.slice(2)))
```

雛形のアプリでは、これを `console` スクリプトとして実行できます。

```bash
bun run console send-digest
bun run console users:create ada@example.com --admin
```

次の 3 つはカーネル自身が処理するので、コマンド一覧やヘルプは何も実装しなくても使えます。

```bash
bun run console list              # 登録済みコマンドを表形式で一覧表示
bun run console                   # 登録済みコマンドを名前空間ごとにグループ表示
bun run console help users:create # 特定コマンドの使い方・引数・オプション
```

コマンド名のあとに `--help` か `-h` を付けると、`help <command>` と同じ内容を表示して、終了コード `0` で終わります。コマンド自体は実行されません。フラグが引数のどの位置にあっても同じです。

```bash
bun run console users:create --help
```

ただし、シグネチャで `--help` や `-h` を自分で宣言しているコマンド（`{-h|--host=}` など）には、そのフラグがそのまま渡ります。

登録されていない名前を渡すと、終了コード `1` で終わり、近い名前の候補が表示されます。

なお、`bin/console.ts` はコマンドに振り分ける前にアプリケーションを起動するので、
`list` を実行するだけでも起動の時間がかかります。マイグレーションのある開発用アプリでは、
起動時にシーダーも実行されます。開発中は `list` や `help` を気軽に使って構いませんが、
デプロイ環境では 1 回呼び出すたびにアプリケーション全体が起動する点に注意してください。

`kernel.handle()` はプロセスを終了させず、終了コードを返す Promise を返します。そのため、テストを書けます。

```ts
import { beforeEach, expect, test } from 'bun:test'
import { BufferedOutput } from '@guren/core'
import { kernel } from '../src/console'

let output: BufferedOutput

// setOutput() は出力を差し替えるだけで元に戻す手段がなく、カーネルは
// モジュールシングルトンです。テストごとに新しいバッファを入れて、
// あるテストの出力が別のテストのアサーションに混ざらないようにします。
beforeEach(() => {
  output = new BufferedOutput()
  kernel.setOutput(output)
})

test('send-digest reports how many digests went out', async () => {
  expect(await kernel.handle(['send-digest'])).toBe(0)
  expect(output.contains('Done!')).toBe(true)
})
```

## コマンドから別のコマンドを呼ぶ

`this.call()` を使うと、登録済みの別のコマンドを実行して、その終了コードを受け取れます。

```ts
async handle(): Promise<number | void> {
  const code = await this.call('cache:clear')

  if (code !== 0) {
    this.error('Could not clear the cache; aborting.')
    return code
  }
}
```

`this.call()` が使えるのは、呼び出し元のコマンドがカーネルを通して実行されている場合だけです。コマンドを直接インスタンス化して `this.call()` を呼ぶと、例外が投げられます。

`this.call()` や `kernel.call()` に渡した引数は、ヘルプの指定とは見なしません。たとえば `this.call('mail:send', ['--subject', subject])` は、`subject` が `-h` でもメールを送信します。

## モジュール

`--module` を付けて生成したコマンドは、`modules/<name>/app/Console/Commands/` に置かれます。モジュール単位のコンソールカーネルはないので、モジュールのディスクリプタを通してルートのカーネルに渡します。`defineModule()` には `routes` や `providers` と並んで `commands` 配列があり、`make:command --module` を実行するとここに追記されます。

```ts
// modules/billing/index.ts
import { defineModule } from '@guren/core'
import InvoiceCommand from './app/Console/Commands/InvoiceCommand.js'

export const billingModule = defineModule({
  name: 'billing',
  prefix: '/billing',
  routes: registerBillingRoutes,
  commands: [InvoiceCommand],
})
```

```ts
// src/console.ts
import { billingModule } from '../modules/billing/index.js'

kernel.registerMany(billingModule.commands)
```

このうち `src/console.ts` 側の行だけは、雛形生成では書かれないので自分で追加します。モジュールごとに一度書いておけば、そのあと `make:command --module billing` で作ったコマンドは自動で登録されます。この行を書くまでは `bunx guren check` が警告を出します。

コマンドのファイルを `src/console.ts` から直接 import しても実行はできますが、モジュールの内部に直接触れることになるため、`bunx guren check --arch` が失敗として報告します。モジュールの外から参照してよいのは `modules/<name>/index.ts` と `modules/<name>/db/schema.ts` だけです。

## デプロイ環境での実行

カーネルをどこで動かすかは、プラットフォームによって変わります。

- **常駐サーバーやコンテナ**: その中で、ローカルと同じように `bun run console <command>` を実行します。コンテナ向けのスケジューラや cron からコマンドを起動する場合も、この方法を使います。
- **サーバーレス**: カーネルに処理を渡す専用のハンドラをエクスポートし、独立した関数としてデプロイします。`createConsoleHandler(kernel)` アダプタと呼び出し方は [サーバーレスガイド](./serverless.md) を参照してください。

データベースを使うコマンドを動かすには、先にアプリケーションを起動しておく必要があります。`bin/console.ts` がコマンドに振り分ける前に `ready` を await しているのはこのためです。起動を省くとモデルが設定されないままになり、クエリがすべて失敗します。

必要なときに実行するのではなく**定期的に実行**したい処理は、[タスクスケジューリングガイド](./scheduling.md) を参照してください。スケジューラからコマンドを起動することもできますが、この 2 つの仕組みはあえて分けてあります。
