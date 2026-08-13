# Guren アップグレードガイド

マイナーバージョン間のアップグレード時に使用する手順です。

## 必須アップグレード手順

1. `CHANGELOG.md` とリリースノートを確認
2. `docs/ja/guides/release-policy.md` の互換性マトリクスを確認
3. 依存更新と生成物再生成

```bash
bun install
bunx guren codegen
```

4. 検証実行

```bash
bun run build
bun run typecheck
bun run test
```

5. 対象バージョンの移行メモを適用

## 移行メモ

### 1.x → 2.0.0

#### 構造的マスアサインメント保護

- **何が変わったか**: `static guarded` と `static strictFillable` は削除されました。`fillable` は常に厳格で、主キー（`id`）は常に黙って除外されます。`AuthenticatableModel` のサブクラスでは、パスワードハッシュとリメンバートークンのカラムは一括代入できません。リクエストボディにこれらが含まれると、`fillable` の内容に関わらず `MassAssignmentException` がスローされます。
- **誰に影響するか**: `guarded` や `strictFillable` を宣言しているモデル（`guren check` がエラーとして検出します）、および `create()` / `update()` で計算済みハッシュやリメンバートークンを一括代入しているコード。
- **移行方法**: `guarded` / `strictFillable` の宣言を削除してください（`bunx guren upgrade --check-only` が対象ファイルを一覧します）。**`guarded` が `id` と認証情報カラム以外のアプリ固有フィールド（`tenantId` や `isAdmin` など）を含んでいた場合、行の削除によりそれらは一括代入可能になります**。それらを含まない `static fillable = [...]` を宣言して保護を維持してください。`strictFillable = false` に依存していたモデルでは、新たにスローされる例外が「黙って破棄されていたフィールド」を示します。`fillable` に追加するかペイロードから除いてください。`create({ ..., passwordHash })` は `create({ ..., password })` に置き換えてモデルにハッシュ化させるか、信頼できるサーバーサイドの値には `forceCreate({ ..., passwordHash: 'oauth:...' })` を使ってください（リクエスト入力には決して使わないこと）。

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
- **移行方法**: 許可リスト内のフィールドだけを渡すか、シーダーやシステムレコードなど信頼できるサーバーサイドのデータには `forceCreate()` / `forceUpdate()` を使用してください。

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
