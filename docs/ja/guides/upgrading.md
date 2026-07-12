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

### rc → 1.0.0

#### 厳格なマスアサインメント

- **何が変わったか**: `fillable` を定義したモデルで、許可リスト外のフィールドを `create()` / `update()` に渡すと `MassAssignmentException` がスローされるようになりました。以前は余分なフィールドは黙って破棄されていました。
- **誰に影響するか**: フィルタリングしていないオブジェクト（スプレッドしたリクエストボディ、マージしたデフォルト値など）を `create()` / `update()` に渡しているコード。
- **移行方法**: 許可リスト内のフィールドだけを渡すか、シーダーやシステムレコードなど信頼できるサーバーサイドのデータには `forceCreate()` / `forceUpdate()` を使用してください。特定のモデルで以前の破棄挙動に戻したい場合は `static strictFillable = false` を設定します。

```ts
// Before: authorId silently dropped when not in fillable
await Post.create({ ...data, authorId: user.id })

// After: either add authorId to fillable, or use forceCreate for trusted data
await Post.forceCreate({ ...validated, authorId: user.id })
```

#### 認証ユーザーレコードのサニタイズ

- **何が変わったか**: `auth.user()` の返すオブジェクトに、パスワードカラム、remember トークンカラム、モデルの `static hidden` に列挙したフィールドが含まれなくなりました。
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
