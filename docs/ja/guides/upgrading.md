# Guren アップグレードガイド

## 未リリース: `analyzeDeployRuntime()` と `judgeDeployRuntime()` を非推奨に

`@guren/cli` が export しているデプロイ実行環境向けの 2 つの関数に `@deprecated`(`deploy-runtime-analysis`)を付けました。呼び出すとプロセスごとに 1 回警告が出ますが、`@guren/cli` 3.0.0 までは動き続けます。

代わりに `checkDeployRuntime(cwd)` を呼んでください。同じ 3 つの判定が返ります。パスワードハッシュとストアの判定は introspect したアプリから読むので、それが得られない場合は `deploy-password-hashing-unverified` と `deploy-runtime-stores-unverified`(参考扱いの警告、advisory)になります。`DeployRuntimeAnalysis` のうち、ハッシャーとセッション設定に関する 6 つのシグナル配列は常に空です。

どちらかの関数を import しているファイルは、`bunx guren upgrade --check-only` で一覧できます。

## 未リリース: キャッシュの同時ミスでコールバックを共有

`cache.store()` で取得したストアの `remember()` と `rememberForever()` は、同じプロセスの中で同じキー・同じ TTL への呼び出しが同時にミスした場合、コールバックを 1 回だけ実行するようになりました。同時にミスした呼び出し元は、全員が同じ結果オブジェクトか同じ例外を受け取ります。ヒットしたときの挙動は変わりません。

ファイルストアと Redis ストアでは、これまで同時にミスした呼び出し元がそれぞれ別のコピーを受け取っていました。今後は結果を共有するので、取得した値をその場で書き換えるコードは、ほかの呼び出し元にも影響します。書き換える前に値をコピーしてください。詳しくは[同時ミス](./cache.md#同時ミス)を参照してください。

## 未リリース: キューのキャンセルと予約

ジョブの `this.signal` は、`fetch` など中断できる I/O に渡してください。タイムアウトするとキャンセルが要求され、ワーカーは `handle()` が終わるのを待ってから再試行します。タイムアウトのあとで正常に終わった処理は、再試行せずに完了として扱います。シグナルを無視する処理は制限時間を超えて動き続けるので、止まらないワーカーを強制終了できるよう、プロセスの監視も用意してください。

Redis ワーカーは予約を更新し続け、古くなった予約に対する完了通知を受け付けません。旧ワーカーは所有権を確認しないので、この更新をデプロイするときはすべてのワーカーを再起動してください。キーの構成と保存済みのペイロードは互換性を保っています。配信は「少なくとも 1 回」のままなので、外部への書き込みには引き続き冪等性キーが必要です。

`SqsDriver` は、ジョブの実行中にメッセージの可視性を更新します。オプションの `visibilityTimeout` には、キューの属性と同じ秒数を設定してください。独自ドライバーには `heartbeatInterval` と `extendReservation(job)` を追加できます。`delete()` の省略可能な第 2 引数には予約トークンが渡されますが、既存のドライバーはそのまま動きます。ドライバーが例外を投げると、ワーカーは実行中フラグを戻して `start()` を失敗させるので、監視側でバックオフを挟んで再起動できます。

以下は、マイナーバージョン間でアップグレードするときの手順です。

## 必須アップグレード手順

1. `CHANGELOG.md` とリリースノートを読む
2. `docs/ja/guides/release-policy.md` の互換性マトリクスを確認する
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

5. 検証を実行する

```bash
bun run build
bun run typecheck
bun run test
```

6. 対象バージョンの移行メモに沿ってコードを直す

## 移行メモ

### 2.23.x → 2.24.0

#### `Model.query()` が非推奨に

- **変更点**: `Model.query()` に `@deprecated` が付き、モデルごとに 1 回だけ警告が出ます。`@guren/orm` 3.0.0 まではこれまでどおり動きます。あわせてクエリビルダーに `sum()`、`avg()`、`min()`、`max()`、`exists()`、`toSql()`、`toDrizzle()` を追加しました。いずれもモデルのグローバルスコープを適用します。
- **影響を受けるコード**: `Post.query()` や `Post.query(db)` を呼んでいるコードです。このクエリはグローバルスコープをすべて素通りするため、`SoftDeletes` やテナントのスコープを持つモデルでは、ゴミ箱に入った行やほかのテナントの行まで読んでいました。
- **移行方法**: `bunx guren upgrade --check-only` で呼び出し箇所を確認してください。何に置き換えるかはクエリの中身によるので、codemod は用意していません。集計はビルダーに、結合は `toDrizzle()` に移します。詳しくは[データベース](./database.md)を参照してください。

```ts
// Before
const rows = await Post.query(db).where(gt(posts.views, 100)).orderBy(desc(posts.id))

// After
const rows = await Post.newQuery().toDrizzle().where(gt(posts.views, 100)).orderBy(desc(posts.id))
```

### 2.22.x → 2.23.0

#### モジュールレベルのサービス setter / getter が非推奨に

- **変更点**: `setGate`/`getGate`、`setEncrypter`/`getEncrypter`、`setMailManager`/`getMailManager`、`setQueueDriver`/`getQueueDriver`、`setI18n`/`getI18n`/`tryGetI18n`、`setLogManager`/`getLogManager`、`setNotificationManager`/`getNotificationManager`、`setBroadcastManager`/`getBroadcastManager`、`setExceptionHandler`/`getExceptionHandler`、`setContainer`/`getContainer`、`setInertiaDocument`、`setInertiaSsrRenderer`、`setInertiaSharedProps`/`getInertiaSharedPropsResolver` に `@deprecated` が付き、シンボルごとに 1 回だけ警告が出ます。3.0.0 まではこれまでどおり動きます。setter は起動中のアプリケーションのコンテナに値をバインドするようになったため、1 つのプロセスに 2 つのアプリケーションがあっても、互いのサービスを上書きしません。
- **影響範囲**: 同じキーをバインドしたうえで setter も呼んでいる provider、getter を通してサービスを読むコード、`setGate()` や `setQueueDriver()` でフェイクを注入しているテストが対象です。
- **移行方法**: まず `bunx guren upgrade --check-only` で対象ファイルを確認し、`bunx guren upgrade` で書き換えます。codemod が行う書き換えは次のとおりです。
  - provider 内の getter を `this.container.make(key)` にする
  - setter に渡していた値を `this.container.instance(key, value)` でバインドする(同じファイルでそのキーをすでにバインドしている場合は、呼び出しを削除する)
  - インラインの `setInertiaDocument({ ... })` を `createApp({ inertia: { document } })` に移す
  - attachments の `storage` ファクトリに、バインド元のコンテナを渡す
  - `Job` 内の `getContainer().make(key)` を `this.make(key)` にする

  テストでの注入は報告するだけで、書き換えはしません。フェイクを入れたマネージャーを `app.container.fake(key, manager)` でバインドしてください（[サービスのフェイク](./testing.md#サービスのフェイク)を参照）。また、codemod は `setQueueDriver()` の呼び出しには手を付けません。3.0.0 までは、このピンがバインド済みのマネージャーより優先されるからです。キューのテストをコンテナのフェイクに移すときは、同じ変更でピンも外してください。

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

- **何が変わったか**: `static guarded` と `static strictFillable` を削除しました。`fillable` は常に厳格に働き、主キー（`id`）は常に何も言わずに除外されます。`AuthenticatableModel` のサブクラスでは、パスワードハッシュと remember トークンのカラムを一括代入できません。リクエストボディにこれらが含まれていると、`fillable` の内容にかかわらず `MassAssignmentException` が投げられます。
- **誰に影響するか**: `guarded` や `strictFillable` を宣言しているモデル（`guren check` がエラーとして検出します）と、`create()` / `update()` で計算済みのハッシュや remember トークンを一括代入しているコードです。
- **移行方法**: `guarded` / `strictFillable` の宣言を削除してください（対象ファイルは `bunx guren upgrade --check-only` で一覧できます）。**`guarded` に `id` と認証情報カラム以外のアプリ固有のフィールド（`tenantId` や `isAdmin` など）を入れていた場合、その行を消すと、それらのフィールドも一括代入できるようになります**。保護を残すには、それらを含まない `static fillable = [...]` を宣言してください。`strictFillable = false` に頼っていたモデルでは、新しく投げられるようになった例外を見れば、これまで黙って捨てられていたフィールドがわかります。そのフィールドは `fillable` に加えるか、ペイロードから外してください。`create({ ..., passwordHash })` は `create({ ..., password })` に書き換えて、ハッシュ化はモデルに任せます。サーバー側で用意した信頼できる値なら `forceCreate({ ..., passwordHash: 'oauth:...' })` も使えますが、リクエストの入力には使わないでください。

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
- **移行方法**: 許可リストにあるフィールドだけを渡してください。シーダーやシステム用のレコードなど、サーバー側で用意した信頼できるデータには `forceCreate()` / `forceUpdate()` を使います。

```ts
// Before: authorId silently dropped when not in fillable
await Post.create({ ...data, authorId: user.id })

// After: keep authorId out of fillable and set it from the session with forceCreate
await Post.forceCreate({ ...validated, authorId: user.id })
```

#### 認証ユーザーレコードのサニタイズ

- **何が変わったか**: `auth.user()` が返すオブジェクトから、パスワードのカラム、remember トークンのカラム、モデルが `hidden` に挙げたフィールドを取り除くようになりました。
- **誰に影響するか**: 認証済みユーザーのオブジェクトから、これらのフィールドを読んでいたコードです。
- **移行方法**: サーバー側の処理でどうしても生のレコードが必要な場合は、モデルを明示的に読み込んでください（例: `User.findOrFail(user.id)`）。

#### SSE ブロードキャスティング

- **何が変わったか**: 認可関数を登録していない `private-` / `presence-` チャンネルは、デフォルトで拒否されるようになりました。また、購読するには、SSE の `connected` イベントで届く `clientId` が必要になりました。
- **誰に影響するか**: SSE のブロードキャスティングエンドポイントを使っているアプリです。
- **移行方法**: `broadcast.privateChannel()` / `broadcast.presenceChannel()` で認可関数を登録します。クライアントは `connected` イベントから `clientId` を受け取って `POST /broadcasting/auth` に送ると、1 回のリクエストで認可と購読が済みます。詳しくは[ブロードキャスティングガイド](./broadcasting.md)を参照してください。

最後に、アップグレードがうまくいったか確かめます。

```bash
bun run typecheck && bun run test
```

## 破壊的変更テンプレート（今後のリリース用）

破壊的変更を記録するときは、項目ごとに次の内容を書きます。

- **何が変わったか**
- **なぜ変えたか**
- **誰に影響するか**
- **Before/After のコード例**
- **1コマンドでの確認手順**
