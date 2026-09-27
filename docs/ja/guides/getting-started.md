# はじめる

このガイドは 2 部構成です。**Part A** では、Docker もデータベースサーバーも使わずに、SQLite で新しい Guren アプリを 5 分ほどで動かします。**Part B** では、Postgres や MySQL、環境変数、機能ジェネレーター、本番ビルドといった本格的なセットアップを扱います。まず Part A を進め、必要になったら Part B に戻ってきてください。

手順は macOS と Linux を前提にしていますが、Windows でも WSL2 を使えば同じ手順で動きます。

> [!NOTE]
> 見慣れない用語があれば [用語集](./glossary.md) を参照してください。

## Part A: クイックスタート（SQLite — Docker 不要）

### 前提条件

- **Bun 1.4.2**。必要なのはこれだけです。

```bash
curl -fsSL https://bun.sh/install | bash
```

### 1. プロジェクトを雛形生成する

```bash
bunx create-guren-app my-app
cd my-app
```

実行するといくつか質問されますが、試すだけならすべてデフォルトのままで構いません。

- **レンダリングモード**: SSR（デフォルト）か SPA。SSR を選ぶと、サーバーで描画した HTML が返り、Vite のアセットも自動で検出されます。
- **データベース**: SQLite（デフォルト、設定不要）、PostgreSQL、MySQL のいずれか。
- **AIエージェント**: [エージェントハーネス](./cli.md#aiエージェントハーネス)を、どのコーディングエージェント向けに用意するか。Claude Code（デフォルト）、Codex、Cursor、GitHub Copilot、OpenCode から選びます。

答え終わると、依存関係がインストールされ、`APP_KEY` を生成済みの `.env` ファイルも作られます。`--mode ssr`、`--db sqlite`、`--agents codex,cursor` のようにフラグを付ければ、質問に対話なしで答えられます。認証の雛形を最初から入れたい場合は `--auth` を付けてください。

### 2. 開発サーバーを起動する

```bash
bun run dev
```

型付きのルートとページのマニフェストを codegen で作り直してから、サーバーが起動します。起動したら `http://localhost:3333` を開いてください。

### 3. 何が表示されるか

ターミナルには Guren のバージョンと URL が入った深紅の ASCII バナーが出て、ブラウザにはウェルカムページが表示されます。SQLite のデータベースファイル `./data/guren.db` は、必要になった時点で作られます。新しいアプリにはまだテーブル定義がないので、初回の起動前にマイグレーションを実行する必要はありません。

![ブラウザに表示されるウェルカムページ。「Welcome to My Blog!」の見出しと、Routing & Controllers、Eloquent-style ORM、Inertia + React、Auth & Sessions、Queue & Mail、Zero-config SQLite の 6 枚のカードが並んでいる](../../images/welcome-page.png)

> [!TIP]
> 開発サーバーはフロントエンドのアセット用に Vite も自動で起動するので、React のページを変更するとすぐに反映されます。サーバー自体も `bun --hot` で動いているため、コントローラー、ルート、モデルといったバックエンドの変更も再起動なしで反映されます。Vite を自分で起動したい場合は `GUREN_DEV_VITE=0` を、スクリプトから実行するときにバナーを出したくない場合は `GUREN_DEV_BANNER=0` を設定してください。

### 4. プロジェクトの知識グラフを見る

開発サーバーを動かしたまま [http://localhost:3333/_guren/docs](http://localhost:3333/_guren/docs) を開いてください。新しいアプリには最初から `docs/adr/` に ADR が入っていて、Docs Graph には文書のノードとして表示されます。プロジェクトが育つにつれて、エンティティ、コードのパス、生成したスペックとの関係も線でつながっていきます。文書をクリックすると、frontmatter、信頼度の情報、リンクの検証結果、Markdown の本文を読めます。

![ローカルの Docs Graph ビューアー。文書・スペック・コードのノードが線で結ばれ、左上に concepts と relations の件数、ノード種別の絞り込みが並んでいる](../../images/docs-graph.png)

ビューアーは読み取り専用です。雛形の `dev` スクリプトに書かれた `GUREN_DOCS=1` で有効になり、手元のマシンからしかアクセスできず、本番ではマウントされません。デフォルトのフルスタック構成の雛形には、生成した図を描画するための Mermaid も入っています。Mermaid がなくても、図のソースはコードブロックとして読めます。スペックビューを生成して設計判断をコードと結び付ける方法は、[スペックアンカード開発](./spec-anchored.md) を参照してください。

### 最初の機能を追加する

アプリが動いたら、次は何か作ってみましょう。次に進むなら **[Guren チュートリアル](../tutorials/00-overview.md)** がおすすめです。今作ったアプリを全 14 章かけてブログに育てていくコースで、各章の作業の一部をコーディングエージェントに任せます。

## Part B: フルセットアップ

ここから先は、最初に触るときにはどれも飛ばして構いません。アプリが大きくなるにつれて必要になる内容です。

### PostgreSQL または MySQL を使う

雛形を生成するときに `--db postgres`（または `--db mysql`）を付けるか、質問に答えるときに選びます。選んだデータベース用の `docker-compose.yml` が書き出され、`DATABASE_URL` もそのデータベースを指すように設定されます。**Docker Desktop（Compose v2）** が入っていれば、次のコマンドでデータベースを起動できます。

```bash
bun run db:up
```

デフォルトの接続文字列は次のとおりです。

- PostgreSQL: `postgres://guren:guren@localhost:54322/guren`
- MySQL: `mysql://guren:guren@localhost:33306/guren`

使い終わったら `bun run db:down` でコンテナを停止します。

> [!TIP]
> ローカルやクラウドですでに Postgres を動かしているなら、Docker は使わずに `DATABASE_URL` をそのインスタンスに向けるだけで構いません。このガイドの残りの手順もそのまま使えます。SQLite で作ったアプリも、あとから `config/database.ts` を書き換えれば切り替えられます。詳しくは [データベースガイド](./database.md) を参照してください。

### 環境変数

雛形の生成時に `.env.example` から `.env` が作られ、新しい `APP_KEY` が書き込まれます。アプリが読む変数はすべて `config/env.ts` で宣言されていて、起動時に検証されます。詳しくは [設定ガイド](./configuration.md) を参照してください。主な変数は次のとおりです。

- `APP_URL`: Inertia に伝えるベース URL（デフォルトは `http://localhost:3333`）。
- `DATABASE_URL`: 接続文字列。SQLite ではファイルパスを、Postgres と MySQL では URL を指定します。
- `PORT`: 開発サーバーの HTTP ポート（デフォルトは `3333`）。
- `CACHE_STORE`、`QUEUE_CONNECTION`、`MAIL_MAILER`: それぞれ `guren add cache`、`guren add queue`、`guren add mail` を実行すると追加され、同時に生成される `config/cache.ts`、`config/queue.ts`、`config/mail.ts` から読まれます。値には、そのファイルで宣言しているストアの名前を指定します。宣言にない名前を `CACHE_STORE`、`QUEUE_CONNECTION`、`MAIL_MAILER` に入れると、起動に失敗します。`SESSION_DRIVER` は、`guren add auth`(または `guren add session`)で `config/session.ts` が書き出されてから使われるようになります。それまでは、セッションはプロセスのメモリ上に置かれます。

> [!CAUTION]
> `.env` はバージョン管理に含めないでください。認証情報をうっかりコミットしてしまった場合は、データベースユーザーの認証情報をローテーションし、ファイルに書かれていた API キーをすべて再発行してください。

### 認証とリソースを追加する

Guren には、機能一式の雛形をまとめて生成するジェネレーターが入っています。

```bash
bunx guren add auth
bunx guren add resource posts --fields "title:string,body:text,published:boolean"
```

`add auth` を実行すると、ユーザー登録、ログイン、ログアウトとセッションミドルウェアが組み込まれます。`add resource` は、指定したフィールドをもとにモデル、マイグレーション、コントローラー、バリデーター、リソース、Inertia ページを生成します。キュー、メール、イベント、ストレージなど、ほかのジェネレーターは `bunx guren add --help` で確認できます。

### 型付きマニフェストを生成する

```bash
bun run codegen
```

codegen を実行すると、型付きのルートヘルパーとページマニフェストが書き出されます。エンドツーエンドの型安全はこのファイルに支えられています。`bun run dev` と `bun run build` の中でも自動で実行されるので、手で実行が必要になるのは、サーバーを止めている間にルートやページを追加したり名前を変えたりした場合だけです。

### マイグレーションとシードデータの投入

リソースを追加してマイグレーションが生成されたら、スキーマを適用してサンプルデータを投入します。

```bash
bun run db:migrate && bun run db:seed
```

このコマンドは SQLite、Postgres、MySQL のどれでも同じように使えます。マイグレーションは `db/schema.ts` に書いた Drizzle のスキーマから生成されます。

### 型チェックとテスト

```bash
bun run typecheck
```

型エラーは出たらすぐに直しましょう。動いているアプリをあとからデバッグするより、早い段階で見つけて直すほうがずっと楽です。テストを書いたら（[テストガイド](./testing.md) を参照）、`bun test` で実行します。

### 本番ビルド

リリースの準備ができたら、次のコマンドを実行します。

```bash
bun run build
bun run preview
```

`build` を実行すると、ファイル名にハッシュが付いたクライアント用アセット（SSR モードではサーバー用アセットも）が `public/assets/` の下に出力され、ランタイムが読むマニフェストも生成されます。`preview` は本番用サーバーを手元で起動するコマンドで、ビルドした結果の動作確認に使います。ホスティング先の選び方は [デプロイガイド](./deployment.md) を参照してください。

## 次のステップ

- **[Guren チュートリアル](../tutorials/00-overview.md)**: はじめて使う人におすすめのハンズオンコースです。ユーザー、認可、リレーションシップ、アップロード、メール、エージェント向けのツールまで扱います。
- **[ファーストステップ](./first-steps.md)**: 1 つのリクエストがフレームワークの中をどう流れるかを 10 分で追いかけます。

そのあとは、次の順にガイドを読み進めてください。

1. [アーキテクチャ](./architecture.md)
2. [ルーティングガイド](./routing.md)
3. [コントローラーガイド](./controllers.md)
4. [データベースガイド](./database.md)
5. [フロントエンドガイド](./frontend.md)
6. [認証ガイド](./authentication.md)
7. [テストガイド](./testing.md)
8. [デプロイガイド](./deployment.md)

読み進める間は、[CLI リファレンス](./cli.md) を開いておくと便利です。不具合を見つけたときやアイデアがあるときは、ぜひ Issue や PR を送ってください。コントリビューションを歓迎しています。
