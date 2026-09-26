# 用語集

Guren のドキュメントによく出てくる言葉を、初学者向けに短くまとめます。ここにない用語は、それぞれのガイドの中で補足しています。

## スタック
- **Bun**: JavaScript/TypeScript のランタイム。`bun run` でスクリプトを実行し、`bunx` で CLI ツールを起動します。
- **Hono**: 軽量な HTTP サーバーフレームワーク。Guren は Hono の上にルーティングやコントローラーを載せています。
- **Inertia.js**: サーバーからページデータ（props）を返し、SPA 的に画面遷移する仕組み。API と SPA の間をつなぐ橋渡し役。
- **React**: UI を作るライブラリ。Guren のビューは React コンポーネントで書きます。
- **Vite**: フロントエンドのビルド/開発サーバー。`bun run dev` の裏で Vite が起動します。
- **Drizzle ORM**: TypeScript 向けの型安全 ORM。Guren のモデルは Drizzle のスキーマに接続します。

## アプリの構造
- **MVC**: Model / View / Controller の分離設計。Guren の基本構造です。
- **Route（ルート）**: パスと HTTP メソッドを、処理（コントローラーや関数）に結びつける定義。
- **Controller（コントローラー）**: リクエストを受け取り、モデルでデータを扱い、レスポンスを返すクラス。
- **Model（モデル）**: DB テーブルと紐づくクラス。`static table` で Drizzle スキーマに接続します。
- **View（ビュー）**: `resources/js/pages/` に置く React ページ。`this.inertia()` で指定します。
- **Middleware（ミドルウェア）**: リクエストの前後に挟み込む処理（認証、ログ、検証など）。
- **Provider（プロバイダー）**: アプリ起動時に設定やサービスを登録する仕組み。
- **Context（コンテキスト）**: Hono の `Context`。リクエスト情報やレスポンス生成に使います。

## データベース
- **ORM**: テーブルをクラスとして扱う仕組み。SQL を直接書かずに操作できます。
- **Schema（スキーマ）**: テーブル定義。`db/schema.ts` に書きます。
- **Migration（マイグレーション）**: スキーマ変更の履歴を SQL ファイルとして管理する方法。
- **Seeder（シーダー）**: テストやデモ用のデータを投入するスクリプト。
- **Database URL**: DB 接続文字列。`.env` の `DATABASE_URL` に設定します。
- **RQB（Relational Query Builder）**: Drizzle のクエリビルダー。複雑な JOIN や集計に使います。
- **Eager Load（イーガーロード）**: 関連データをまとめて取得すること。`with()` などで指定します。

## フロントエンド
- **SPA**: ページ遷移で画面全体を再読み込みしないアプリ。
- **SSR**: サーバー側で HTML を生成して返す方式。初回表示が速くなります。
- **Props（プロップス）**: コンポーネントに渡すデータ。Inertia ではサーバーが props を返します。
- **HMR**: Vite によるフロントエンドのホットリロード。ページを保存すると画面が即時更新されます。バックエンド（コントローラー・ルート・モデル）も `bun --hot` で動くため、再起動なしで反映されます。
- **Inertia ページ**: `resources/js/pages/` に置く React コンポーネント。通常は `pages.posts.Index` のような page definition を使い、`this.inertia()` から参照します。`pages` は codegen が `.guren/pages.gen.ts` に生成します。

## CLI
- **create-guren-app**: 新規アプリのひな形を作る CLI。
- **guren CLI**: `bunx guren make:*` などの開発用コマンド群。

## エージェントハーネス
- **エージェントハーネス**: `create-guren-app` がコーディングエージェント向けに入れるファイル一式。エージェントが最初に読むもの、編集のあとに走るもの、ターンを終える前に走るものを含みます。
- **CLAUDE.md**: Claude Code がセッションの最初に読むプロジェクトの説明書。[公式ドキュメント](https://code.claude.com/docs/ja/memory)
- **ルール(rules)**: `.claude/rules/` に置く指示。`paths` に合うファイルを編集するときだけ読み込まれます。[公式ドキュメント](https://code.claude.com/docs/ja/memory#path-specific-rules)
- **スキル(skills)**: 特定の種類の作業でエージェントが従う手順。`.claude/skills/<name>/SKILL.md` に書きます。[公式ドキュメント](https://code.claude.com/docs/ja/skills)
- **サブエージェント(subagents)**: 独自の指示と独自のコンテキストを持ち、メインのエージェントから呼び出されるエージェント。`.claude/agents/` に置きます。[公式ドキュメント](https://code.claude.com/docs/ja/sub-agents)
- **hooks**: セッション開始、ファイル編集、ターン終了などの時点で Claude Code が実行するコマンド。`.claude/settings.json` に書きます。[公式ドキュメント](https://code.claude.com/docs/ja/hooks)
- **ゲート(`guren gate`)**: codegen、typecheck、lint、`check`、`audit`、テストをまとめて実行するコマンド。CI と `Stop` hook が同じものを走らせます。

## 計画の状態
`plan:status`、`plan:verify`、`plan:next` はステップや要素の状態を英語の値で表示します。詳しくは[実装計画](./implementation-plans.md)を参照してください。
- **`verified`**: 検証コマンドがすべて通り、その記録が今も有効な状態。
- **`failed`**: 検証コマンドが失敗した状態。直す箇所があります。
- **`blocked`**: スクリプトがない、データベースにつながらない、時間切れなど、環境の都合で検証を実行できなかった状態。実装の失敗ではありません。
- **`drifted`**: 検証が通ったあとで、記録したファイルが変わった状態。`plan:verify --step` で確かめ直します。
- **`stalled`**: `Stop` hook が差し戻しても検証が通らず、理由を記録して止めた状態。次の `plan:next` が報告します。
- **`held`**: 承認後にアプリ側の前提が変わったため、`plan:next` がステップを保留した状態。
- **`waived`**: `plan:waive` で、未完了のまま受け入れた状態。
- **advisory**: 表示はするものの、`--ci` や `guren gate` を失敗させない参考扱いの結果。

## まずはここから
- [はじめの一歩](./first-steps.md)
- [Getting Started](./getting-started.md)
