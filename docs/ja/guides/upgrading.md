# Guren アップグレードガイド

アプリを新しいバージョンに上げるときは、このガイドを使います。下の手順に沿って進めてください。移行メモはリリース（GitHub のリリースに付いたバージョン）ごとに、新しいものから順に並んでいます。またいだリリースの分を、古いものから順に当てはめます。

## 必須アップグレード手順

1. `CHANGELOG.md` とリリースノートを読む
2. [リリースポリシー](./release-policy.md)の互換性マトリクスを確認する
3. 依存関係を更新し、生成物を作り直す

```bash
bun install
bunx guren codegen
```

4. 非推奨 API を使っている箇所を確認する

```bash
bunx guren upgrade --check-only
```

項目ごとに、非推奨になったバージョン、削除される予定のバージョン、置き換え先、使っているファイルが表示されます。ファイルには何も書き込みません。

5. 今のバージョンから目標のバージョンまでの移行メモに沿ってコードを直す
6. 検証を実行する

```bash
bun run build
bun run typecheck
bun run test
```

## 移行メモ

### 2.26.x → 2.27.0

#### `analyzeDeployRuntime()` と `judgeDeployRuntime()` が非推奨に

- **何が変わったか**: デプロイしてよい状態かを確かめるスクリプト向けに `@guren/cli` が公開しているこの 2 つの関数に、`@deprecated` が付きました。呼び出すと、それぞれプロセスごとに 1 回警告が出ますが、`@guren/cli` 3.0.0 までは動き続けます。
- **誰に影響するか**: どちらかを import しているスクリプトです。`bunx guren upgrade --check-only` で一覧できます。
- **移行方法**: `checkDeployRuntime(cwd)` を呼んでください。同じ 3 つの判定が返り、アプリがデプロイ先を宣言していなければ何も返りません。パスワードのハッシャーとセッションのストアは、アプリを起動せずに読み込んで調べます。読み込みに失敗した場合、この 2 つの判定は参考扱いの `deploy-password-hashing-unverified` と `deploy-runtime-stores-unverified` になります。`DeployRuntimeAnalysis` のうち、ハッシャーとセッション設定に関する 6 つのシグナル配列は常に空です。

#### キャッシュの同時ミスでコールバックを共有

- **何が変わったか**: 同じプロセスの中で、同じキー・同じ TTL への呼び出しが同時にミスした場合、`cache.store()` で取得したストアの `remember()` と `rememberForever()` はコールバックを 1 回だけ実行します。同時にミスした呼び出し元は、全員が同じ結果オブジェクトか同じ例外を受け取ります。ヒットしたときの挙動は変わりません。
- **誰に影響するか**: ファイルストアや Redis ストアで、取得した値をその場で書き換えているコードです。これまでは同時にミスした呼び出し元がそれぞれ別のコピーを受け取っていましたが、今後は結果を共有するので、書き換えがほかの呼び出し元にも及びます。
- **移行方法**: 書き換える前に値をコピーしてください（`structuredClone(value)`）。詳しくは[同時ミス](./cache.md#同時ミス)を参照してください。

### 2.25.x → 2.26.0

#### キューのキャンセルと予約

- **何が変わったか**: ジョブは `this.signal` でキャンセルのシグナルを受け取ります。シグナルは、ジョブがタイムアウトしたときと、そのジョブを別のワーカーに取られたときに中断されます。タイムアウトのあと、ワーカーは `handle()` が終わるのを待ってから再試行し、遅れて正常に終わった処理は再試行せずに完了として扱います。実行中のジョブには、ワーカーが「予約」を持っています。Redis ワーカーは予約を更新し続け、ジョブを別のワーカーが引き取ったあとは、元のワーカーからの完了通知を受け付けません。`SqsDriver` も、ジョブの実行中はメッセージをほかのワーカーから見えないように保ちます。
- **誰に影響するか**: キューでジョブを動かしているアプリ（特に Redis と SQS）と、独自のキュードライバーです。
- **移行方法**（すべてのアプリ）:
  - `this.signal` を、`fetch` など中断できる I/O に渡してください。シグナルを無視する処理は制限時間を超えて動き続けるので、止まらないワーカーを止められるプロセスマネージャー（systemd やコンテナの再起動ポリシーなど）を用意します。
  - この更新をデプロイするときは、すべてのワーカーを再起動してください。古いワーカーは予約を確認しないためです。キーの構成と保存済みのペイロードは互換性を保っています。
  - SQS では、`SqsDriver` の `visibilityTimeout` オプションに、キューの可視性タイムアウトを秒単位で設定してください（既定は 30）。
  - 配信は「少なくとも 1 回」のままなので、外部への書き込みには引き続き冪等性キーが必要です。
- **移行方法**（独自のキュードライバー）: 予約を更新するには、`heartbeatInterval` と `extendReservation(job)` を実装します。`delete()` には省略可能な第 2 引数（予約トークン）が加わりましたが、既存のドライバーはそのまま動きます。ドライバーが失敗するとワーカーの状態を戻して `start()` を失敗させるので、プロセスマネージャーがバックオフを挟んで再起動できます。

```ts
import { Job } from '@guren/core'

export class SyncInvoiceJob extends Job<{ url: string }> {
  async handle(payload: { url: string }) {
    await fetch(payload.url, { signal: this.signal })
  }
}
```

### 2.23.x → 2.24.0

#### `Model.query()` が非推奨に

- **何が変わったか**: `Model.query()` に `@deprecated` が付き、モデルごとに 1 回だけ警告が出ます。`@guren/orm` 3.0.0 まではこれまでどおり動きます。あわせてクエリビルダーに `sum()`、`avg()`、`min()`、`max()`、`exists()`、`toSql()`、`toDrizzle()` を追加しました。いずれもモデルのグローバルスコープを適用します。
- **誰に影響するか**: `Post.query()` や `Post.query(db)` を呼んでいるコードです。このクエリはグローバルスコープをすべて素通りするため、`SoftDeletes` やテナントのスコープを持つモデルでは、ゴミ箱に入った行やほかのテナントの行まで読んでいました。
- **移行方法**: `bunx guren upgrade --check-only` で呼び出し箇所を確認してください。何に置き換えるかはクエリの中身によるので、codemod は用意していません。集計はビルダーに、結合は `toDrizzle()` に移します。詳しくは[Drizzle に渡す](./database.md#drizzle-に渡すtodrizzle)を参照してください。

```ts
// Before
const rows = await Post.query(db).where(gt(posts.views, 100)).orderBy(desc(posts.id))

// After
const rows = await Post.newQuery().toDrizzle().where(gt(posts.views, 100)).orderBy(desc(posts.id))
```

### 2.22.x → 2.23.0

#### モジュールレベルのサービス setter / getter が非推奨に

- **何が変わったか**: `setGate`/`getGate`、`setEncrypter`/`getEncrypter`、`setMailManager`/`getMailManager`、`setQueueDriver`/`getQueueDriver`、`setI18n`/`getI18n`/`tryGetI18n`、`setLogManager`/`getLogManager`、`setNotificationManager`/`getNotificationManager`、`setBroadcastManager`/`getBroadcastManager`、`setExceptionHandler`/`getExceptionHandler`、`setContainer`/`getContainer`、`setInertiaDocument`、`setInertiaSsrRenderer`、`setInertiaSharedProps`/`getInertiaSharedPropsResolver` に `@deprecated` が付き、シンボルごとに 1 回だけ警告が出ます。3.0.0 まではこれまでどおり動きます。setter は起動中のアプリケーションのコンテナに値をバインドするようになったため、1 つのプロセスに 2 つのアプリケーションがあっても、互いのサービスを上書きしません。
- **誰に影響するか**: 同じキーをバインドしたうえで setter も呼んでいるプロバイダー、getter を通してサービスを読むコード、`setGate()` や `setQueueDriver()` でフェイクを注入しているテストが対象です。
- **移行方法**: まず `bunx guren upgrade --check-only` で対象ファイルを確認し、`bunx guren upgrade` で書き換えます。codemod が行う書き換えは次のとおりです。
  - プロバイダー内の getter を `this.container.make(key)` にする
  - setter に渡していた値を `this.container.instance(key, value)` でバインドする（同じファイルでそのキーをすでにバインドしている場合は、呼び出しを削除する）
  - インラインの `setInertiaDocument({ ... })` を `createApp({ inertia: { document } })` に移す
  - attachments の `storage` ファクトリに、バインド元のコンテナを渡す
  - `Job` 内の `getContainer().make(key)` を `this.make(key)` にする

  テストでの注入は報告するだけで、書き換えはしません。フェイクを入れたマネージャーを `app.container.fake(key, manager)` でバインドしてください（[サービスのフェイク](./testing.md#サービスのフェイク)を参照）。また、codemod は `setQueueDriver()` の呼び出しには手を付けません。3.0.0 までは、このピンがバインド済みのマネージャーより優先されるためです。キューのテストをコンテナのフェイクに移すときは、同じ変更でピンも外してください。

```ts
// Before
export default class AuthorizationProvider extends ServiceProvider {
  boot(): void {
    getGate().policy(Post, PostPolicy)
  }
}

// After
export default class AuthorizationProvider extends ServiceProvider {
  boot(): void {
    this.container.make('gate').policy(Post, PostPolicy)
  }
}
```

これらのアクセサをもとにした関数ヘルパーは、非推奨にはならず、シグネチャも変わりません。`encrypt`、`decrypt`、`t`、`tc`、`can`、`cannot`、`defineGate`、`authorizeAbility`、`resolve`、`Job.dispatch`、`Job.make` は、どれも実行中のアプリケーションのコンテナから解決します。

### 1.x → 2.0.0

#### 構造的マスアサインメント保護

- **何が変わったか**: `static guarded` と `static strictFillable` を削除しました。`fillable` は常に厳格に働き、主キー（`id`）は常に黙って取り除かれます。`AuthenticatableModel` のサブクラスでは、パスワードハッシュと remember トークンのカラムを一括代入できません。リクエストボディにこれらが含まれていると、`fillable` の内容にかかわらず `MassAssignmentException` が投げられます。
- **誰に影響するか**: `guarded` や `strictFillable` を宣言しているモデル（`guren check` がエラーとして検出します）と、`create()` / `update()` で計算済みのハッシュや remember トークンを一括代入しているコードです。
- **移行方法**: 対象ファイルは `bunx guren upgrade --check-only` で一覧できます。
  - `guarded` と `strictFillable` の宣言を削除します。
  - **`guarded` に `id` と認証情報カラム以外のアプリ固有のフィールド（`tenantId` や `isAdmin` など）を入れていた場合、削除するとそれらも一括代入できるようになります。** 保護を残すには、それらを含まない `static fillable = [...]` を宣言してください。
  - `strictFillable = false` に頼っていたモデルでは、新しく投げられる例外を見れば、これまで黙って捨てられていたフィールドがわかります。そのフィールドは `fillable` に加えるか、ペイロードから外してください。
  - `create({ ..., passwordHash })` は `create({ ..., password })` に書き換えて、ハッシュ化はモデルに任せます。サーバー側で用意した信頼できる値には `forceCreate({ ..., passwordHash: 'oauth:...' })` を使えますが、リクエストの入力には使わないでください。

```ts
// Before
export class User extends defineModel(users, { base: AuthenticatableModel }) {
  static fillable = ['name', 'email', 'password']
  static guarded = ['id', 'passwordHash', 'rememberToken']  // check がエラーにする
}

// After — 認証情報カラムはフレームワークが拒否する
export class User extends defineModel(users, { base: AuthenticatableModel }) {
  static fillable = ['name', 'email', 'password']
}
```

`ModelUserProvider` は認証情報のカラム名をモデル（`passwordHashField` と、新しく加わった `rememberTokenField`）から読み取ります。そのため、カラム名を変えてもプロバイダー側を設定し直す必要はありません。`passwordColumn` / `rememberTokenColumn` オプションを明示した場合は、これまでどおりそちらが優先されます。また、`defineModel()` の非推奨だった `createType` オプションは削除しました。代わりに `optionalOnCreate` / `requireOnCreate` を使ってください。

### rc → 1.0.0

#### 厳格なマスアサインメント

- **何が変わったか**: `fillable` を定義したモデルで、許可リストにないフィールドを `create()` / `update()` に渡すと、`MassAssignmentException` が投げられるようになりました。以前は、余分なフィールドは黙って捨てられていました。
- **誰に影響するか**: 絞り込んでいないオブジェクト（スプレッドしたリクエストボディや、デフォルト値をマージしたものなど）を `create()` / `update()` に渡しているコードです。
- **移行方法**: データには許可リストにあるフィールドだけを渡してください。著者のようにサーバーが決めるカラムは `set` オプションで渡します（[サーバーが決めるカラム](./database.md#サーバーが決めるカラム)）。シーダーやシステム用のレコードなど、リクエストのデータを含まない書き込みには `forceCreate()` / `forceUpdate()` を使います。

```ts
// Before: authorId silently dropped when not in fillable
await Post.create({ ...data, authorId: user.id })

// After: keep authorId out of fillable and pass it from the session in set
await Post.create(data, { set: { authorId: user.id } })
```

#### 認証ユーザーレコードのサニタイズ

- **何が変わったか**: `auth.user()` が返すオブジェクトから、パスワードのカラム、remember トークンのカラム、モデルが `hidden` に挙げたフィールドを取り除くようになりました。
- **誰に影響するか**: 認証済みユーザーのオブジェクトから、これらのフィールドを読んでいたコードです。
- **移行方法**: サーバー側の処理でどうしても生のレコードが必要な場合は、モデルを明示的に読み込んでください（例: `User.findOrFail(user.id)`）。

#### SSE ブロードキャスティング

- **何が変わったか**: 認可関数を登録していない `private-` / `presence-` チャンネルは、デフォルトで拒否されるようになりました。また、購読するには、SSE の `connected` イベントで届く `clientId` が必要になりました。
- **誰に影響するか**: SSE のブロードキャスティングエンドポイントを使っているアプリです。
- **移行方法**: `broadcast.privateChannel()` / `broadcast.presenceChannel()` で認可関数を登録します。クライアントは `connected` イベントから `clientId` を受け取って `POST /broadcasting/auth` に送ると、1 回のリクエストで認可と購読が済みます。詳しくは[ブロードキャスティングガイド](./broadcasting.md)を参照してください。

## 破壊的変更テンプレート（メンテナー向け）

リリースで何かを壊すときは、その移行メモに次の内容を書きます。

- **何が変わったか**
- **なぜ変えたか**
- **誰に影響するか**
- **Before/After のコード例**
- **1 コマンドでの確認手順**
