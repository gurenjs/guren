# コンソールコマンド

コンソールコマンドを使うと、バックフィル・単発のメンテナンス・レポート生成といった処理を、HTTP ハンドラと同じモデル・サービス・コンテナを使ってターミナルから実行できます。

コマンドはクラスです。カーネルがそれらのクラスを集約し、`argv` に応じてどれかにディスパッチします。どちらもアプリケーション側が所有するため、登録するまでコマンドは動きません。

> フレームワークの対話型 REPL である `bunx guren console` とは別物です。REPL については [CLI リファレンス](./cli.md#対話-repl) を参照してください。本ガイドで扱うのは**アプリケーションが定義する**コマンドです。

## コマンドを定義する

CLI で生成します。

```bash
bunx guren make:command SendDigest
```

`app/Console/Commands/SendDigestCommand.ts` が作られます。

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

コマンドに必要なのは 2 つの static プロパティと 1 つのメソッドだけです。

- `static signature` — コマンド名と、その引数・オプション（後述）。
- `static description` — `list` や `help` に表示される 1 行の説明。
- `handle()` — 実処理。成功時は何も返さない（または `0` を返す）、失敗時は 0 以外の数値を返すと終了コードになります。捕捉されなかった例外は `this.error()` で報告され、終了コード `1` になります。

kebab-case の既定名ではなく呼び出し名を指定したい場合は `--command` を渡します。

```bash
bunx guren make:command SendDigest --command reports:digest
```

## シグネチャの構文

シグネチャ文字列でコマンド名・位置引数・オプションを宣言します。

```ts
static signature = 'users:create {email} {name?} {--admin} {--role=member}'
```

| トークン | 意味 |
|-------|---------|
| `{name}` | 必須の引数 |
| `{name?}` | 省略可能な引数 |
| `{name=default}` | 既定値を持つ引数 |
| `{name*}` | 配列引数 — 以降をすべて受け取るため、最後に置く |
| `{--flag}` | 真偽値オプション。指定しなければ `false` |
| `{--opt=}` | 値を取るオプション |
| `{--opt=default}` | 既定値を持つオプション |
| `{-o\|--opt}` | 短縮形を持つオプション |
| `{--opt=*}` | 繰り返し指定できるオプション |

各トークンは空白を含まない `{...}` のかたまりである必要があります。それ以外はシグネチャ文字列から無視されるため、波括弧の中にスペースが混ざるとその引数が黙って消えます。

パース済みの値は `handle()` の中で読み取ります。

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

必須の引数が省略された場合、`argument()` は `undefined` を返します。パーサ側で弾いてはくれないので、必須にしたい値は自分で検証してください。真偽値オプションは常に定義済みです（フラグがなければ `false`）。

## 出力

コマンドは `this.output` を通じて出力します。クラス側にショートハンドが用意されています。

```ts
this.info('Starting the backfill')     // INFO  …
this.success('Backfill complete')      // DONE  …
this.warn('3 rows were skipped')       // WARN  …
this.error('Could not reach the API')  // ERROR … (stderr)
this.line('plain, unprefixed text')
this.newLine()

this.table(['ID', 'Email'], rows)
```

時間のかかる処理では、`withProgress()` が反復しながらプログレスバーを描画します。

```ts
await this.withProgress(users, async (user) => {
  await sendDigest(user)
})
```

## 対話的な入力

人が実行するコマンドでは、質問を投げられます。

```ts
const name = await this.ask('Project name?', 'my-app')
const proceed = await this.confirm('Drop the staging database?')
const env = await this.choice('Target environment', ['staging', 'production'])
const token = await this.secret('API token')
```

これらは標準入力から読み取ります。同じコマンドを無人環境（CI やスケジューラ）でも動かす場合は、`--force` のようなオプションで囲ってください。

## コマンドを登録する

`app/Console/Commands` を自動でスキャンする仕組みはありません。生成したコマンドはカーネルに登録するまでデッドコードです。これは意図的な設計で、デプロイがファイルシステムの glob に依存しないようにするためです。

スキャフォールドされたアプリには、まさにこのための `src/console.ts` が含まれています。

```ts
import { ConsoleKernel } from '@guren/core'
import SendDigestCommand from '../app/Console/Commands/SendDigestCommand.js'
import app from './app.js'

export const kernel = new ConsoleKernel({ container: app.container })

kernel.register(SendDigestCommand)
```

`app.container` を渡すと、コマンド内で `this.resolve()` によるサービス解決ができるようになります。複数まとめて登録するには `registerMany([FirstCommand, SecondCommand])` を使います。

このファイルが無い時期に作られたプロジェクトでは、自分で作成してください。デプロイ用のレシピがこの名前で import するため、**エクスポート名は必ず `kernel`** にする必要があります。

## コマンドを実行する

`bin/console.ts` がアプリケーションを起動し、`argv` をカーネルに渡します。

```ts
import { ready } from '../src/main.js'
import { kernel } from '../src/console.js'

await ready

process.exit(await kernel.handle(process.argv.slice(2)))
```

スキャフォールドされたアプリでは `console` スクリプトとして公開されています。

```bash
bun run console send-digest
bun run console users:create ada@example.com --admin
```

カーネルは次の 3 つを自前で処理するため、コマンド一覧やヘルプは追加実装なしで使えます。

```bash
bun run console list              # 登録済みコマンドを説明つきで一覧表示
bun run console help users:create # 特定コマンドの使い方・引数・オプション
bun run console                   # list と同じ
```

未知の名前を渡すと終了コード `1` になり、近い候補を提案します。

`kernel.handle()` はプロセスを終了させず終了コードを解決して返すため、テストが書けます。

```ts
import { BufferedOutput } from '@guren/core'
import { kernel } from '../src/console'

test('send-digest reports how many digests went out', async () => {
  const output = new BufferedOutput()
  kernel.setOutput(output)

  expect(await kernel.handle(['send-digest'])).toBe(0)
  expect(output.contains('Done!')).toBe(true)
})
```

## コマンドから別のコマンドを呼ぶ

`this.call()` は登録済みの別コマンドを実行し、その終了コードを返します。

```ts
async handle(): Promise<number | void> {
  const code = await this.call('cache:clear')

  if (code !== 0) {
    this.error('Could not clear the cache; aborting.')
    return code
  }
}
```

これは呼び出し元のコマンドがカーネル経由でディスパッチされていることが前提です。直接インスタンス化したコマンドで `this.call()` を呼ぶと例外になります。

## モジュール

`--module` を付けて生成したコマンドは `modules/<name>/app/Console/Commands/` に置かれます。モジュールごとのコンソールカーネルは存在しないため、ルートの `src/console.ts` にまとめて登録してください。

```ts
import InvoiceCommand from '../modules/billing/app/Console/Commands/InvoiceCommand.js'

kernel.register(InvoiceCommand)
```

## デプロイ環境での実行

カーネルをどこで動かすかは、プラットフォームによって変わります。

- **常駐サーバー / コンテナ** — その中で `bun bin/console.ts <command>` をローカルと同じように実行します。コンテナベースのスケジューラや cron からコマンドを起動する場合もこの形です。
- **サーバーレス** — カーネルに処理を渡す専用ハンドラをエクスポートし、独立した関数としてデプロイします。`createConsoleHandler(kernel)` アダプタと呼び出し方法は [サーバーレスガイド](./serverless.md) を参照してください。

データベースに触れるコマンドは、先にアプリケーションが起動している必要があります。`bin/console.ts` がディスパッチ前に `ready` を await しているのはこのためです。起動を飛ばすとモデルが未設定のままになり、すべてのクエリが失敗します。

オンデマンドではなく**定期実行**したい処理については [タスクスケジューリングガイド](./scheduling.md) を参照してください。スケジューラからコマンドを起動できますが、2 つのサブシステムは意図的に分離されています。

## 関連ドキュメント

- [CLI リファレンス](./cli.md) — `guren` フレームワーク CLI。`make:command` と対話型 REPL を含む。
- [タスクスケジューリング](./scheduling.md) — cron 相当のスケジュールでの実行。
- [サーバーレス](./serverless.md) — AWS Lambda 上でのコマンド実行。
