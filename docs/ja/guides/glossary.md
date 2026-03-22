# 用語集

Guren のドキュメントで頻出する言葉を、初学者向けに短くまとめます。ここにない用語は各ガイドの文脈で補足しています。

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
- **HMR**: ホットリロード。変更を保存すると画面が即時更新されます。
- **Inertia ページ**: `resources/js/pages/` に置く React コンポーネント。通常は `appPages.posts.index` のような page contract を通して `this.inertia()` で参照します。

## CLI
- **create-guren-app**: 新規アプリのひな形を作る CLI。
- **guren CLI**: `bunx guren make:*` などの開発用コマンド群。

## まずはここから
- [はじめの一歩](./first-steps.md)
- [Getting Started](./getting-started.md)
