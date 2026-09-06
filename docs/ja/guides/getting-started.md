# はじめる

このガイドは 2 部構成です。**Part A** では、Docker もデータベースサーバーも使わず、SQLite で新規 Guren アプリを 5 分程度で動かします。**Part B** ではフルセットアップを扱います: Postgres / MySQL、環境変数、機能ジェネレーター、本番ビルドなどです。まず Part A から始めて、必要になったら Part B に戻ってきてください。

手順は macOS と Linux を対象としていますが、Windows でも WSL2 を使えば同じように動きます。

> [!NOTE]
> 見慣れない用語があれば [用語集](./glossary.md) を参照してください。

## Part A: クイックスタート（SQLite — Docker 不要）

### 前提条件

- **Bun 1.1 以降** — これだけです。

```bash
curl -fsSL https://bun.sh/install | bash
```

### 1. プロジェクトを雛形生成する

```bash
bunx create-guren-app my-app
cd my-app
```

スキャフォールダーはいくつかの選択を尋ねます。始めるだけならデフォルトのままで問題ありません。

- **レンダリングモード**: SSR（デフォルト）または SPA。SSR ではサーバーレンダリングされた HTML と Vite アセットの自動検出が使えます。
- **データベース**: SQLite（デフォルト、設定不要）、PostgreSQL、または MySQL。
- **AIエージェント**: [エージェントハーネス](./cli.md#aiエージェントハーネス)をどのコーディングエージェント向けに構成するか。Claude Code（デフォルト）・Codex・Cursor・GitHub Copilot・OpenCode から選択します。

その後、依存関係をインストールし、生成済みの `APP_KEY` 入りの `.env` ファイルを作成してくれます。フラグでプロンプトに先回りして答えられます: `--mode ssr`、`--db sqlite`、`--agents codex,cursor`。認証の雛形を最初から含めるなら `--auth` です。

### 2. 開発サーバーを起動する

```bash
bun run dev
```

型付きのルート／ページマニフェストを再生成（codegen）してからサーバーを起動します。`http://localhost:3333` を開いてください。

### 3. 何が表示されるか

ターミナルには Guren のバージョンと URL を添えた深紅の ASCII バナーが、ブラウザにはウェルカムページが表示されます。SQLite のデータベースファイルは必要になった時点で `./data/guren.db` に作成されます。新規アプリにはまだテーブル定義がないため、初回起動前にマイグレーションを実行する必要はありません。

![ブラウザに表示されるウェルカムページ。「Welcome to My Blog!」の見出しと、Routing & Controllers、Eloquent-style ORM、Inertia + React、Auth & Sessions、Queue & Mail、Zero-config SQLite の 6 枚のカードが並んでいる](../../images/welcome-page.png)

> [!TIP]
> 開発サーバーはフロントエンドアセット用に Vite を自動起動するため、React ページへの変更は即座に反映されます。コントローラー・ルート・モデルといったバックエンドの変更も、`bun --hot` で動いているため再起動なしで反映されます。Vite を自分で起動したい場合は `GUREN_DEV_VITE=0` を、スクリプト実行時にバナーを消したい場合は `GUREN_DEV_BANNER=0` を設定してください。

### 4. プロジェクトの知識グラフを見る

開発サーバーを動かしたまま [http://localhost:3333/_guren/docs](http://localhost:3333/_guren/docs) を開いてください。新規アプリには `docs/adr/` 配下にシード ADR が含まれており、Docs Graph では文書ノードとして表示されます。プロジェクトが育つにつれて、エンティティ、コードパス、生成スペックとの関係も加わります。文書をクリックすると、frontmatter、trust 情報、リンクの検証結果、Markdown 本文を読めます。

![ローカルの Docs Graph ビューアー。文書・スペック・コードのノードが線で結ばれ、左上に concepts と relations の件数、ノード種別の絞り込みが並んでいる](../../images/docs-graph.png)

ビューアーは読み取り専用です。スキャフォールドされた `dev` スクリプトの `GUREN_DOCS=1` で有効になり、自分のマシンからだけ到達でき、本番では決してマウントされません。デフォルトのフルスタック・スキャフォールドには生成図を描画する Mermaid も含まれます。Mermaid がなくても図のソースはコードブロックとして読めます。スペックビューを生成し、意思決定をコードへ結び付ける方法は [スペックアンカード開発](./spec-anchored.md) を参照してください。

### 最初の機能を追加する

アプリが動いたら、次は何かを作ってみましょう。おすすめの次のステップは **[ミニブログを作るチュートリアル](../tutorials/overview.md)** です。今作ったアプリに、投稿の CRUD、認証、リレーションシップを使ったコメント機能を追加していく 3 部構成のコースです。

## Part B: フルセットアップ

以下はすべて初回セッションでは省略可能ですが、アプリが成長するにつれて必要になるものです。

### PostgreSQL または MySQL を使う

雛形生成時に `--db postgres`（または `--db mysql`）を渡すか、プロンプトで選択します。スキャフォールダーが対応するデータベースの `docker-compose.yml` を書き出し、`DATABASE_URL` をそこに向けてくれます。**Docker Desktop（Compose v2）** がインストールされていれば、次のコマンドでデータベースを起動できます。

```bash
bun run db:up
```

デフォルトの接続文字列:

- PostgreSQL: `postgres://guren:guren@localhost:54322/guren`
- MySQL: `mysql://guren:guren@localhost:33306/guren`

使い終わったら `bun run db:down` でコンテナを停止します。

> [!TIP]
> すでにローカルやクラウドで Postgres が動いていますか？ その場合は Docker を使わず、`DATABASE_URL` をそのインスタンスに向けるだけで構いません — このガイドの残りはそのまま通用します。SQLite で作ったアプリも、あとから `config/database.ts` を更新すれば切り替えられます。詳しくは [データベースガイド](./database.md) を参照してください。

### 環境変数

スキャフォールダーは `.env.example` から `.env` を作成し、新しい `APP_KEY` を書き込みます。主な設定:

- `APP_URL`: Inertia に伝えるベース URL（デフォルト `http://localhost:3333`）。
- `DATABASE_URL`: 接続文字列 — SQLite ではファイルパス、Postgres / MySQL では URL。
- `PORT`: 開発サーバーの HTTP ポート（デフォルト `3333`）。
- `CACHE_STORE`、`QUEUE_CONNECTION`、`MAIL_MAILER`: `guren add cache` / `guren add queue` / `guren add mail` が生成するプロバイダが読みます。値はそのプロバイダが宣言しているストア名である必要があります。`SESSION_DRIVER` はまだ読まれていないため、セッションはプロセスメモリ上にあります。

> [!CAUTION]
> `.env` はバージョン管理に含めないでください。もしコミットに認証情報が漏れてしまった場合は、データベースユーザーをローテーションし、ファイル内で参照している API キーをすべて再生成してください。

### 認証とリソースを追加する

Guren には機能一式を雛形生成するジェネレーターが同梱されています。

```bash
bunx guren add auth
bunx guren add resource posts --fields "title:string,body:text,published:boolean"
```

`add auth` はユーザー登録、ログイン、ログアウト、セッションミドルウェアをセットアップします。`add resource` は指定したフィールドに基づいて、モデル、マイグレーション、コントローラー、バリデーター、リソース、Inertia ページを生成します。ほかのジェネレーター（キュー、メール、イベント、ストレージなど）は `bunx guren add --help` で確認できます。

### 型付きマニフェストを生成する

```bash
bun run codegen
```

codegen は、エンドツーエンドの型安全を支える型付きルートヘルパーとページマニフェストを書き出します。`bun run dev` と `bun run build` が自動で実行するため、手動で実行する必要があるのは、サーバー停止中にルートやページを追加・リネームした場合だけです。

### マイグレーションとシードデータの投入

リソースを追加した（＝マイグレーションが生成された）ら、スキーマを適用してサンプルデータを投入します。

```bash
bun run db:migrate && bun run db:seed
```

これは SQLite、Postgres、MySQL のいずれでも同じように動きます。マイグレーションは `db/schema.ts` の Drizzle スキーマから生成されます。

### 型チェックとテスト

```bash
bun run typecheck
```

型エラーは出たそばから修正しましょう — 問題を早期に捕まえるほうが、動いているアプリをデバッグするよりずっと簡単です。テストを追加したら（[テストガイド](./testing.md) 参照）、`bun test` で実行します。

### 本番ビルド

リリースの準備ができたら:

```bash
bun run build
bun run preview
```

`build` はハッシュ付きのクライアントアセット（SSR モードではサーバーアセットも）を `public/assets/` 以下に出力し、ランタイムが読み込むマニフェストも生成します。`preview` は本番サーバーをローカルで起動するので、ビルドの動作確認ができます。ホスティングの選択肢は [デプロイガイド](./deployment.md) を参照してください。

## 次のステップ

- **[ミニブログを作るチュートリアル](../tutorials/overview.md)** — 初めての方におすすめのハンズオンコース。投稿の CRUD、認証、そしてコメントとリレーションシップを扱います。
- **[ファーストステップ](./first-steps.md)** — 1 つのリクエストがフレームワークをどう流れるかを辿る 10 分のツアー。

その後は、次の順番でガイドを読み進めてください。

1. [アーキテクチャ](./architecture.md)
2. [ルーティングガイド](./routing.md)
3. [コントローラーガイド](./controllers.md)
4. [データベースガイド](./database.md)
5. [フロントエンドガイド](./frontend.md)
6. [認証ガイド](./authentication.md)
7. [テストガイド](./testing.md)
8. [デプロイガイド](./deployment.md)

道中では [CLI リファレンス](./cli.md) を手元に置いておくと便利です。問題を見つけたりアイデアがあれば、ぜひ Issue や PR を送ってください — コントリビューションを歓迎します。
