# Guren アップグレードガイド

minor 間アップグレード時に使用する手順です。

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

## Minor 移行メモ

### 0.2.x -> 0.3.x

- 現時点で追加の移行手順はありません。
- 実験的 API を利用している場合は `bunx guren doctor` を再実行して警告を解消してください。

## 破壊的変更テンプレート（今後の minor 用）

各項目で次を記載します:

- **何が変わったか**
- **なぜ変えたか**
- **誰に影響するか**
- **Before/After のコード例**
- **1コマンドでの確認手順**
