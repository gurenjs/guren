# セッション

セッションは、ブラウザごとの状態をリクエストをまたいで保持する仕組みで、セッションガードはログインしたユーザーの識別子をここに保存します。このページでは、セッションのミドルウェアの付け方、Cookie の設定、セッションを置くストア（メモリ、データベース、暗号化した Cookie、Redis）を説明します。ユーザーのサインインについては[認証](./authentication.md)を参照してください。

## セッションの有効化

ガードはセッションを使います。`createApp()` に `auth` オプションを渡すと、`AuthServiceProvider` がセッションのミドルウェア（と CSRF）を自動で付けます。設定を変えるときも、そこにオプションを渡します。

```ts
import { createApp } from '@guren/core'

const app = createApp({
  auth: {
    autoSession: true, // 無効化したい場合は false
    sessionOptions: {
      cookieSecure: process.env.NODE_ENV === 'production',
    },
  },
})
```

`auth` オプションを使わずに、セッションのミドルウェアを自分でマウントすることもできます。ただしその場合は、CSRF の保護もプロバイダーによるセッションの扱いも付きません。

```ts
import { createApp, createSessionMiddleware } from '@guren/core'

const app = createApp()
app.use('*', createSessionMiddleware())
```

`cookieSecure` は、セッション Cookie に `Secure` 属性を付けるかどうかを決めます。`Secure` は HTTPS のときだけ Cookie を送らせる属性なので、本番では `true` にしてください。ローカル開発は `http://localhost` で動かすので、デフォルトは `false` になっています。

**Application の auth オプション**
- `autoSession`（デフォルト `true`）: `createSessionMiddleware` を自動で付けます。
- `sessionOptions`（`createSessionMiddleware` にそのまま渡されます）:
  - `cookieName`(デフォルト `guren.session`)
  - `cookieSecure`(本番は `true`、開発は `false` がデフォルト)
  - `cookieSameSite`(デフォルト `Lax`)
  - `cookieHttpOnly`(デフォルト `true`)
  - `cookieMaxAgeSeconds`（任意。指定しなければ `ttlSeconds` を使います）
  - `ttlSeconds`（デフォルトは 2 時間）
  - `store`（デフォルトはメモリストア。複数インスタンスの構成では独自の実装に差し替えてください）。ストアそのものか、ストアを返す関数を渡します。関数は起動時ではなくリクエストごとに呼ばれます（結果は `SessionManager` 側でメモ化されます）。

## `SessionManager` でストアを選ぶ

`bunx guren add session` を実行すると、次のものが生成されます。

- `sessions` テーブルとそのマイグレーション
- `database` と `cookie` のストアを宣言した `config/session.ts`
- `SESSION_DRIVER` キー（`config/env.ts` に `database` をデフォルトとして宣言し、`.env` と `.env.example` にも追加）
- `sessions:prune` コマンド

定義は `createApp({ config })` に追加されます。下の例のうち `redis` ストアだけは手で書き足す部分です。`@guren/core/redis` を import すると ioredis がすべてのバンドルに入るので、必要になるまで雛形には含めていません。

`guren add auth` はこのコマンドを内部で実行するので、生成した直後のアプリでも、セッションは最初からデータベースに保存されます。以下は、手で組み込む場合に備えて、生成されるものを説明したものです。

[`--oauth`](./oauth.md#oauth-ログインボタン) と同じく、`config/env.ts` がないアプリや、すでにプロバイダーが `session` をバインドしているアプリでは、プレーンな `SessionConfig` としての `config/session.ts` と、それをバインドする `app/Providers/SessionProvider.ts` が生成されます。

使う可能性のあるストアが複数あるなら、まとめて宣言しておき、環境ごとに選びます。`defineSessionConfig` が `session` キーに `SessionManager` をバインドし、`AuthServiceProvider` は起動時に、それを組み込んだセッションミドルウェアを組み立てます。ストア自体は最初のリクエストのときに解決されます。

```ts
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'
import { sessions } from '../db/schema'

export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  ttlSeconds: 60 * 60 * 2,
  stores: {
    // 再起動・isolate・コールドスタートをまたいで残ります。接続は
    // `configureOrm()` が確立済みのもの(Postgres / MySQL / SQLite / D1)を使います。
    database: { driver: 'database', table: sessions },
    cookie: { driver: 'cookie' },
    // `client` は関数でも構いません。このストアが最初に使われたときに実行されるので、
    // 宣言しただけで選ばれていないストアは接続を開きません。
    redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) },
  },
}))
```

`REDIS_URL` は `config/env.ts` に宣言します。`@guren/core/redis` は ioredis を読み込むので、実際に使う設定ファイルでだけ import してください。定義は、データベースの定義と並べて登録します。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import session from '../config/session.js'

const app = createApp({
  env,
  config: [database, session],
})
```

`defineSessionConfig()` は、マネージャーを `createSessionManager()` で組み立てます。`createSessionManager()` は、`new SessionManager()` に `database` ドライバーを登録したものです。このドライバーはテーブルを ORM のモデルで包むので、ORM に依存しない HTTP 層には置けず、`@guren/core` からしか提供できません。`database` ストアを宣言するときは、常にこちらを使ってください。

別の方法で組み立てたマネージャーには、`registerDatabaseSessionDriver(manager)` でドライバーを追加できます。

### `cookie` ストア

`{ driver: 'cookie' }` は、セッション全体を cookie の中に入れ、`APP_KEY` で暗号化します（AES-256-GCM。`APP_PREVIOUS_KEYS` も復号に使うので、鍵をローテーションしても全員がログアウトすることはありません）。**サーバ側のリソースをまったく必要としない**唯一のストアで、テーブルもマイグレーションも Redis も Workers のバインディングもいりません。

```ts
stores: {
  cookie: { driver: 'cookie' },
}
```

このストアにはできないことが 3 つあります。理解したうえで選んでください。

- **セッションの中身がすべて cookie に入る**ので、サイズに上限があります。ミドルウェアは送り出す `Set-Cookie` 全体（名前と属性を含む）の大きさを測り、`maxCookieBytes`（既定は 4096。ブラウザが保持できる大きさ）を超えるとエラーにします。ブラウザに黙って捨てられる cookie を出すよりはよいからです。セッション本体に使えるのは約 2.9KB です。レコードはデータベースに置き、セッションにはその id だけを入れてください
- **ログアウトしても、クライアントがすでに複製した cookie は失効させられません**。`invalidate()` が消すのはそのクライアントの cookie だけで、複製は期限まで有効なままです。失効させる必要があるものはデータベースに置いてください
- **「すべての端末からログアウト」も、セッションの一覧表示もできません**。サーバ側に列挙できるものがないためです

`ttlSeconds` はよく考えて設定してください。サーバ側から cookie を期限前に失効させる手段がないので、暗号化したペイロード自身の有効期限が唯一の上限になります。

### `database` ストアと起動時の検査

`database` ドライバーを使うには、`db/schema.ts` の `sessions` テーブルとそのマイグレーションが必要です。カラムは `id`（text の主キー）・`data`・`expiresAt` の 3 つで、方言ごとの定義は [Cloudflare ガイド](./cloudflare.md#セッションと-oauth-state-はデータベースに保存する) にあります。

期限切れの行は、`manager.pruneExpired()` を定期的に実行して片付けてください（`read()` は期限切れの行をすでに存在しないものとして扱います）。

マネージャー側の cookie と TTL の設定が基本になり、`auth.sessionOptions` がそれをフィールドごとに上書きします。次の設定ミスは起動時にエラーになるので、`SESSION_DRIVER` の打ち間違いも最初のログインより前に見つかります。

- `auth.sessionOptions.store` とマネージャーの両方を設定した（どちらかを黙って選ぶことはしません）
- `default` のストアのドライバーが登録されていない
- `default` の名前が `stores` に宣言されていない（`AuthServiceProvider` がマネージャーを組み立てる時点で検出します）

`memory` は常に宣言済みなので、`SESSION_DRIVER=memory` はエントリを書かなくても動きます。マネージャーは、どのプロバイダーの boot よりも前にバインドされます。詳しくは [config 定義](./configuration.md#config-定義) を参照してください。

プラグインがドライバーを追加するときは、`SessionDrivers` インターフェースを型の拡張（module augmentation）で広げ、`manager.registerDriver(name, factory)` を呼びます。ストアの解決は遅延して行われるので、プラグインの `register()` が設定の宣言より後に実行されても問題ありません。

> [!WARNING]
> Cloudflare Workers、AWS Lambda、Vercel ではリクエストの間でメモリを共有しないので、デフォルトの `MemorySessionStore` を使うと、ログインした直後のリクエストでセッションが失われます。ミドルウェアはこの状況を検出するとプロセスごとに 1 度警告を出し、`guren check` とデプロイのビルドは事前に警告します。
