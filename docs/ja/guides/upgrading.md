# Guren アップグレードガイド

## 未リリース: キューのキャンセルと予約

ジョブの `this.signal` を `fetch` など中断に対応する I/O に渡してください。
タイムアウトはキャンセルを要求し、ワーカーは `handle()` の終了後に再試行します。
タイムアウト後に正常終了した処理は再試行せず完了扱いにします。
シグナルを無視する処理は制限時間を超えるため、停止しないワーカーを
強制終了するプロセス監視も必要です。

Redis ワーカーは予約を更新し、古い予約に対する完了通知を拒否します。
この更新のデプロイ時には全ワーカーを再起動してください。旧ワーカーには
所有権の確認がありません。キー構成と保存済みペイロードは互換性を維持します。
配信は少なくとも一度なので、外部への書き込みには引き続き冪等性キーが必要です。

`SqsDriver` はジョブの実行中にメッセージの可視性を更新します。オプションの
`visibilityTimeout` にキュー属性と同じ秒数を設定してください。独自ドライバーには
`heartbeatInterval` と `extendReservation(job)` を追加できます。
`delete()` の任意の第2引数が予約トークンです。既存のドライバーはそのまま使えます。
ドライバーの例外では実行中フラグを解除して `start()` が失敗するため、監視側で
バックオフを入れて再起動できます。

マイナーバージョン間のアップグレード時に使用する手順です。

## 必須アップグレード手順

1. `CHANGELOG.md` とリリースノートを確認
2. `docs/ja/guides/release-policy.md` の互換性マトリクスを確認
3. 依存更新と生成物再生成

```bash
bun install
bunx guren codegen
```

4. 非推奨APIの使用箇所を確認

```bash
bunx guren upgrade --check-only
```

非推奨化されたバージョン、削除予定バージョン、置き換え先、使用しているファイルが項目ごとに表示されます。ファイルへの書き込みは行いません。

5. 検証実行

```bash
bun run build
bun run typecheck
bun run test
```

6. 対象バージョンの移行メモを適用

## 移行メモ

### 2.23.x → 2.24.0

#### `Model.query()` が非推奨に

- **変更点**: `Model.query()` に `@deprecated` が付き、モデルごとに一度だけ警告します。`@guren/orm` 3.0.0 までは従来どおり動きます。クエリビルダーには `sum()`、`avg()`、`min()`、`max()`、`exists()`、`toSql()`、`toDrizzle()` が加わり、いずれもモデルのグローバルスコープを適用します。
- **影響を受けるコード**: `Post.query()` や `Post.query(db)` を呼んでいるコードです。このクエリはグローバルスコープをすべて素通りするので、`SoftDeletes` やテナントのスコープを持つモデルでは、ゴミ箱に入った行や他テナントの行を読んでいました。
- **移行方法**: `bunx guren upgrade --check-only` で呼び出し箇所を確認してください。置き換え先はクエリの内容で決まるため、codemod はありません。集計はビルダーへ、結合は `toDrizzle()` へ移します。詳しくは[データベース](./database.md)を参照してください。

```ts
// Before
const rows = await Post.query(db).where(gt(posts.views, 100)).orderBy(desc(posts.id))

// After
const rows = await Post.newQuery().toDrizzle().where(gt(posts.views, 100)).orderBy(desc(posts.id))
```

### 2.22.x → 2.23.0

#### モジュールレベルのサービス setter / getter が非推奨に

- **変更点**: `setGate`/`getGate`、`setEncrypter`/`getEncrypter`、`setMailManager`/`getMailManager`、`setQueueDriver`/`getQueueDriver`、`setI18n`/`getI18n`/`tryGetI18n`、`setLogManager`/`getLogManager`、`setNotificationManager`/`getNotificationManager`、`setBroadcastManager`/`getBroadcastManager`、`setExceptionHandler`/`getExceptionHandler`、`setContainer`/`getContainer`、`setInertiaDocument`、`setInertiaSsrRenderer`、`setInertiaSharedProps`/`getInertiaSharedPropsResolver` に `@deprecated` が付き、シンボルごとに一度だけ警告します。3.0.0 までは従来どおり動きます。setter は起動中のアプリケーションのコンテナに値をバインドするようになったので、1 プロセスに 2 つのアプリケーションがあってもサービスを上書きし合いません。
- **影響範囲**: 同じキーをバインドしたうえで setter も呼んでいる provider、getter 経由でサービスを読むコード、`setGate()` や `setQueueDriver()` でフェイクを注入しているテストです。
- **移行方法**: まず `bunx guren upgrade --check-only` で対象ファイルを確認し、`bunx guren upgrade` で書き換えを適用します。codemod は provider 内の getter を `this.container.make(key)` にし、setter の値を `this.container.instance(key, value)` でバインドし（同じファイルがそのキーをすでにバインドしている場合は呼び出しを削除）、インラインの `setInertiaDocument({ ... })` を `createApp({ inertia: { document } })` へ移し、attachments の `storage` ファクトリにバインド元のコンテナを渡し、`Job` 内の `getContainer().make(key)` を `this.make(key)` に書き換えます。テストの注入は報告のみで書き換えません。フェイクを入れたマネージャーを `app.container.fake(key, manager)` でバインドしてください（[サービスのフェイク](./testing.md#サービスのフェイク)を参照）。codemod は `setQueueDriver()` の呼び出しには手を付けません。3.0.0 まではピンがバインド済みマネージャーより優先されるためです。キューのテストをコンテナのフェイクに移すときは、同じ変更でピンも外してください。

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

これらのアクセサの上に作られた関数ヘルパーは非推奨ではなく、シグネチャも変わりません。`encrypt`、`decrypt`、`t`、`tc`、`can`、`cannot`、`defineGate`、`authorizeAbility`、`resolve`、`Job.dispatch`、`Job.make` はいずれも、実行中のアプリケーションのコンテナから解決します。

### 1.x → 2.0.0

#### 構造的マスアサインメント保護

- **何が変わったか**: `static guarded` と `static strictFillable` は削除されました。`fillable` は常に厳格で、主キー（`id`）は常に黙って除外されます。`AuthenticatableModel` のサブクラスでは、パスワードハッシュとリメンバートークンのカラムは一括代入できません。リクエストボディにこれらが含まれると、`fillable` の内容に関わらず `MassAssignmentException` がスローされます。
- **誰に影響するか**: `guarded` や `strictFillable` を宣言しているモデル（`guren check` がエラーとして検出します）、および `create()` / `update()` で計算済みハッシュやリメンバートークンを一括代入しているコード。
- **移行方法**: `guarded` / `strictFillable` の宣言を削除してください（対象ファイルは `bunx guren upgrade --check-only` が一覧します）。**`guarded` に `id` と認証情報カラム以外のアプリ固有フィールド（`tenantId` や `isAdmin` など）が含まれていた場合、行を削除するとそれらは一括代入できるようになります**。保護を保つには、それらを含まない `static fillable = [...]` を宣言してください。`strictFillable = false` に頼っていたモデルでは、新たにスローされる例外が、これまで黙って破棄されていたフィールドを教えてくれます。`fillable` に追加するか、ペイロードから外してください。`create({ ..., passwordHash })` は `create({ ..., password })` に置き換えて、モデル側でハッシュ化させます。信頼できるサーバーサイドの値であれば `forceCreate({ ..., passwordHash: 'oauth:...' })` を使えます（リクエスト入力には使わないでください）。

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

`ModelUserProvider` は認証情報カラム名をモデル（`passwordHashField` / 新設の `rememberTokenField`）から読み取るため、カラムをリネームしてもプロバイダー側の設定は不要です（明示的な `passwordColumn` / `rememberTokenColumn` オプションは引き続き優先されます）。`defineModel()` の非推奨だった `createType` オプションは削除されました。`optionalOnCreate` / `requireOnCreate` を使ってください。

### rc → 1.0.0

#### 厳格なマスアサインメント

- **何が変わったか**: `fillable` を定義したモデルで、許可リスト外のフィールドを `create()` / `update()` に渡すと `MassAssignmentException` がスローされるようになりました。以前は余分なフィールドは黙って破棄されていました。
- **誰に影響するか**: フィルタリングしていないオブジェクト（スプレッドしたリクエストボディ、マージしたデフォルト値など）を `create()` / `update()` に渡しているコード。
- **移行方法**: 許可リスト内のフィールドだけを渡してください。シーダーやシステムレコードなど信頼できるサーバーサイドのデータには `forceCreate()` / `forceUpdate()` を使います。

```ts
// Before: authorId silently dropped when not in fillable
await Post.create({ ...data, authorId: user.id })

// After: either add authorId to fillable, or use forceCreate for trusted data
await Post.forceCreate({ ...validated, authorId: user.id })
```

#### 認証ユーザーレコードのサニタイズ

- **何が変わったか**: `auth.user()` の返すオブジェクトに、パスワードカラム、remember トークンカラム、モデルが `hidden` に列挙したフィールドが含まれなくなりました。
- **誰に影響するか**: 認証済みユーザーオブジェクトからこれらのフィールドを読み取っていたコード。
- **移行方法**: 生のレコードが必要なまれなサーバーサイド処理では、モデルを明示的にロードしてください（例: `User.findOrFail(user.id)`）。

#### SSE ブロードキャスティング

- **何が変わったか**: 認可関数が未登録の `private-` / `presence-` チャンネルはデフォルトで拒否されるようになりました。また、購読には SSE の `connected` イベントで配信される `clientId` が必要です。
- **誰に影響するか**: SSE ブロードキャスティングエンドポイントを使用しているアプリ。
- **移行方法**: `broadcast.privateChannel()` / `broadcast.presenceChannel()` で認可関数を登録し、`connected` イベントから `clientId` を取得して `POST /broadcasting/auth` に送信すると、認可と購読が 1 回のリクエストで行われます。詳細は[ブロードキャスティングガイド](./broadcasting.md)を参照してください。

アップグレードの検証:

```bash
bun run typecheck && bun run test
```

## 破壊的変更テンプレート（今後のリリース用）

各項目で次を記載します。

- **何が変わったか**
- **なぜ変えたか**
- **誰に影響するか**
- **Before/After のコード例**
- **1コマンドでの確認手順**
