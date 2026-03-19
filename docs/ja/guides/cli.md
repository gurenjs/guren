# CLI リファレンス

Guren には 2 つの CLI が付属します:

- 既存プロジェクト内でコントローラ/モデル/ビュー生成やユーティリティを実行する `bunx guren`
- 新規アプリをスキャフォールドする `bunx create-guren-app`

## 基本的な使い方

```bash
# グローバルインストール不要。プロジェクトルートでそのまま実行
bunx guren --help
```

コマンドは `bunx guren make:controller UserController` のようなサブコマンド形式です。

## 主要コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `make:controller <Name>` | `app/Http/Controllers` にコントローラを生成 | `bunx guren make:controller PostController` |
| `make:model <Name>` | 最小のモデルクラスと型定義を `app/Models` に生成（`db/schema` から `camelCase(Name)s` を import） | `bunx guren make:model Post` |
| `make:view <path>` | `resources/js/pages` に React コンポーネントを生成 | `bunx guren make:view posts/Index` |
| `make:auth` | ログイン/ログアウトのコントローラ、プロバイダー、ビュー、マイグレーション、シーダー、ルートをスキャフォールド | `bunx guren make:auth` |
| `make:middleware <Name>` | `app/Http/Middleware` にミドルウェアを生成 | `bunx guren make:middleware Auth` |
| `make:seeder <Name>` | データベースシーダーファイルを生成 | `bunx guren make:seeder UserSeeder` |
| `make:job <Name>` | キュー可能なジョブクラスを生成 | `bunx guren make:job SendEmail` |
| `make:event <Name>` | イベントクラスを生成 | `bunx guren make:event UserRegistered` |
| `make:listener <Name>` | イベントリスナークラスを生成 | `bunx guren make:listener SendWelcomeEmail` |
| `make:notification <Name>` | 通知クラスを生成 | `bunx guren make:notification InvoicePaid` |
| `make:mail <Name>` | メールクラスを生成 | `bunx guren make:mail WelcomeEmail` |

> **Note:** `make:*` は既存ファイルを上書きしません。必要なら `--force` を付けてください。

## ルートコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `route:list` | 登録済み全ルートを一覧表示 | `bunx guren route:list` |

### route:list オプション

フィルタリングとソート機能付きで全アプリケーションルートを表示します：

```bash
# 全ルートを一覧表示
bunx guren route:list

# HTTPメソッドでフィルタリング
bunx guren route:list --method GET

# パスパターンでフィルタリング
bunx guren route:list --path users

# ルート名でフィルタリング
bunx guren route:list --name admin

# ルートをソート
bunx guren route:list --sort path
bunx guren route:list --sort method
bunx guren route:list --sort name

# ソート順を逆にする
bunx guren route:list --sort path --reverse

# 出力フォーマット
bunx guren route:list --format table   # デフォルトのテーブル形式
bunx guren route:list --format json    # JSON出力
bunx guren route:list --format compact # コンパクトな1行形式
```

## 設定コマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `config:cache` | 全設定ファイルをキャッシュ | `bunx guren config:cache` |
| `config:clear` | 設定キャッシュをクリア | `bunx guren config:clear` |
| `config:show` | 設定キャッシュ情報を表示 | `bunx guren config:show` |

### 設定キャッシュ

本番環境でのパフォーマンス向上のために設定ファイルをキャッシュします：

```bash
# 全設定をキャッシュ
bunx guren config:cache

# キャッシュをクリア
bunx guren config:clear

# キャッシュ情報を表示
bunx guren config:show
```

キャッシュは `bootstrap/cache/config.json` に保存されます。設定ファイルは `config/` ディレクトリ（サブディレクトリ含む）から読み込まれます。

**Note:** 設定ファイルを変更した後は、`config:cache` を再実行してキャッシュを更新してください。

## データベースコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `db:migrate` | 保留中のマイグレーションを実行 | `bunx guren db:migrate` |
| `db:rollback` | 最後のマイグレーションバッチをロールバック | `bunx guren db:rollback` |
| `db:reset` | 全テーブルを削除してマイグレーションを再実行 | `bunx guren db:reset` |
| `db:seed` | データベースシーダーを実行 | `bunx guren db:seed` |

### db:migrate オプション

```bash
# マイグレーションを実行
bunx guren db:migrate

# 本番環境でマイグレーションを強制実行
bunx guren db:migrate --force

# マイグレーションパスを指定
bunx guren db:migrate --path db/migrations
```

### db:rollback オプション

```bash
# 最後のバッチをロールバック
bunx guren db:rollback

# 指定ステップ数ロールバック
bunx guren db:rollback --step 3

# 全マイグレーションをロールバック
bunx guren db:rollback --all
```

### db:seed オプション

```bash
# 全シーダーを実行
bunx guren db:seed

# 特定のシーダーを実行
bunx guren db:seed --class UserSeeder

# 本番環境でシーディングを強制実行
bunx guren db:seed --force
```

## キューコマンド

| コマンド | 説明 | 例 |
|----------|------|----|
| `queue:work` | キューに入ったジョブの処理を開始 | `bunx guren queue:work` |

### queue:work オプション

```bash
# デフォルトキューからジョブを処理
bunx guren queue:work

# 特定のキューを処理
bunx guren queue:work --queue emails

# ジョブ数を制限
bunx guren queue:work --max-jobs 100

# キューが空になったら停止
bunx guren queue:work --stop-when-empty
```

## 共通オプション

オプションは `packages/core/src/cli` で一元化され、挙動が統一されています:

- `--force` / `-f`: 既存ファイルを上書き
- `--dry-run`: 生成内容を表示するだけで書き込まない（予定）
- `--cwd <path>`: 指定パスのワークスペースでコマンドを実行（既定はカレントディレクトリ）

## テンプレートの特徴

生成物はフレームワークの Laravel 風エルゴノミクスに沿っています:

- コントローラは `Controller` を継承し、`this.inertia()` などのヘルパーを使用。
- モデルは `Model<TRecord>` を継承し、`static table` を事前に設定。手早い CRUD にはヘルパーを、複雑なクエリは Drizzle RQB へ直接。`Model.query(db)` でモデル起点の RQB も書けます。
- ビューは React + TypeScript + Tailwind CSS の関数コンポーネント。

生成後はルート配線と Drizzle スキーマへの `static table` 接続を忘れずに。高度なクエリが必要ならモデルを介さず Drizzle の DB（`getDatabase()`）や `Model.query()` を使うと型安全のまま柔軟に書けます。

## 新規アプリのスキャフォールド

ゼロから始めるときは専用ブートストラッパーを使います:

```bash
bunx create-guren-app my-app
```

CLI はデフォルトテンプレートをコピーし、メタデータを更新、レンダリングモードを選択するプロンプトを出します。既定の **SSR** は `autoConfigureInertiaAssets` 経由で SSR を有効にし、**SPA** を選ぶと無効化します。プロンプトをスキップする場合は `--mode ssr` または `--mode spa`、空でないディレクトリに生成する場合は `--force` を付けます。

## トラブルシュート
- `command not found: bunx`: Bun が古い可能性があります。1.1 以降にアップグレードしてください。
- `Error: Port already in use`: 開発サーバー（既定 3333）が埋まっています。`.env` の `PORT` を変更して再起動してください。
- `Database connection failed`: Postgres に到達できるか、`.env` が `postgres://guren:guren@localhost:54322/guren` を指しているか確認してください。

## 対話 REPL

フレームワーク対応のコンソールを起動:

```bash
bunx guren console
```

アプリケーションをブート（`src/main.ts` と登録済みプロバイダーを尊重）し、`app`、`auth`、発見済みモデル、DB ヘルパー、`@guren/testing` のユーティリティなどを事前ロードしたプロンプトに入ります。`:help` でショートカット、`:editor` で複数行入力を使えます。

### 典型的な流れ

1. **起動** — プロジェクトルートで `bunx guren console`。
2. **コード実行** — `src/main.ts` などのブートストラップ済みスコープを共有するため、`await Post.all()` のようなステートメントをそのまま実行できます。
3. **状態リセット** — `Ctrl+D`（または `.exit`）で終了し、必要に応じて再起動。

### Tips

- `Ctrl+D` または `.exit` で REPL を抜ける。
- `reloadModels()` で、コンソール起動中に追加したモデルを再検出。
- `:load path/to/script.ts` でファイル内容を現在のセッションに読み込む。
- 素の Bun REPL が必要なら `bun repl`（または `bun repl --inspect`）を使う。

これらのパターンで、専用の `guren repl` を待たずとも反復開発の体験を得られます。
