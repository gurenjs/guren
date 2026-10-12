# エージェントハーネス

`create-guren-app` で作ったアプリには、AI エージェント向けのハーネスが入っています。コーディングエージェントに Guren のアプリでの作業のしかたを伝えるファイルと、作業中に Guren のチェックを走らせる hooks です。このページでは、エージェントごとに入るもの、hooks の動き、`agent:init` と `agent:sync` によるファイルの管理を説明します。

## エージェントを選ぶ

雛形を作るときに使うエージェント（Claude Code、Codex、Cursor、GitHub Copilot、OpenCode）を選ぶと、それぞれのエージェントがそのまま読み込める形でファイルがインストールされます。非対話の環境では `--agents codex,cursor` のように指定し、`--agents none` で入れないこともできます。

選んだエージェントごとに、次のものが生成されます。

| エージェント | プロジェクトガイド | ルールとスキル | MCP の設定 | ターン終了時のゲート |
|--------------|--------------------|----------------|------------|----------------------|
| Claude Code | `CLAUDE.md` | `.claude/` 配下のルール、スキル、サブエージェント | `.mcp.json` | `Stop` hook が、失敗した指摘を添えて停止を 1 回ブロックする |
| Codex | `AGENTS.md` | `.agents/rules/`、`.agents/skills/`、コマンドの許可リスト `.codex/rules/guren.rules` | `.codex/config.toml` | `.codex/hooks.json` が停止を 1 回ブロックする（Codex のプロジェクト単位の hook は、`/hooks` で一度信頼すると動きます） |
| Cursor | `AGENTS.md` | `.agents/` と `.cursor/rules/guren-*.mdc` | `.cursor/mcp.json` | `.cursor/hooks.json` が指摘を自動の追加メッセージとして送る（回数の上限は `loop_limit`） |
| GitHub Copilot | `AGENTS.md` | `.agents/` と `.github/instructions/guren-*.instructions.md` | `.vscode/mcp.json` | なし（`AGENTS.md` で `guren gate` の実行を指示） |
| OpenCode | `AGENTS.md` | `.agents/` | `opencode.json` の `mcp` エントリ | なし（`AGENTS.md` で `guren gate` の実行を指示） |

スキルはエージェント共通の SKILL.md 標準形式です。MCP の設定は開発サーバーの MCP エンドポイントを指し、エンドポイントは生成された `dev` スクリプトの `GUREN_MCP=1` で有効になります。

ハーネスが書き出すファイルの仕様は、各エージェントの公式ドキュメントで確認できます。Claude Code については [`CLAUDE.md` と `.claude/rules/`](https://code.claude.com/docs/ja/memory)、[スキル](https://code.claude.com/docs/ja/skills)、[サブエージェント](https://code.claude.com/docs/ja/sub-agents)、[hooks](https://code.claude.com/docs/ja/hooks)、[MCP](https://code.claude.com/docs/ja/mcp)、[`settings.json`](https://code.claude.com/docs/ja/settings) のページです。ほかのエージェントについては、[`AGENTS.md`](https://agents.md/) の形式、[Agent Skills](https://agentskills.io/) の標準、Cursor の [Rules](https://cursor.com/ja/docs/rules) と [Hooks](https://cursor.com/ja/docs/hooks)、GitHub Copilot の[リポジトリのカスタム指示](https://docs.github.com/ja/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions)、OpenCode の [Rules](https://opencode.ai/docs/rules/) を参照してください。

## hooks

エージェントごとに、次のものが動きます。

- Claude Code、Codex、Cursor では、コミットしていない変更を残したままターンが終わると、ゲートの hook が [`guren gate`](./cli.md#検査監査コマンド) を実行します。失敗したステージは CI まで持ち越さず、同じターンの中で直せます。`guren plan:next` で印を付けた計画のステップがまだ検証を通っていなければ（[実装計画](./implementation-plans.md)を参照）、そのステップの指摘も最大 3 回まで差し戻します。
- Claude Code ではさらに、セッションの開始時に `guren context` のプロジェクトマップを読み込みます。ルート、`app/Http/`、モデル、スキーマ、ページを編集すると `guren check` を再実行し、アプリに `.oxlintrc.json` があれば、編集したソースファイルに oxlint をかけます。
- GitHub Copilot と OpenCode には hooks がありません。代わりに `AGENTS.md` で、セッション開始時に `guren context`、編集後に `guren check`、作業を終える前に `guren gate` を実行するよう指示しています。

hook が効く範囲には、次の注意点があります。

- hook は、自分がインストールされたアプリにゲートをかけるので、monorepo の中のアプリでは、そのアプリのツリーだけが対象です。Claude Code の hook はセッションがいる checkout にゲートをかけるので、途中で worktree に入った場合は、その worktree のツリーが対象です。
- Cursor は `.cursor/hooks.json` をワークスペースのルートから読むので、アプリは単独のワークスペースとして開いてください。
- Cursor は設定によっては `.claude/settings.json` の hook も読み込みます。その場合は Claude 用の hook が処理を譲るので、ゲートは 1 回しか走りません。

## アプリを作る前に: カタログから Guren のスキルを入れる

上のハーネスはアプリの `@guren/cli` に入っているので、アプリを作るまでは存在しません。それより前、Guren を知らないエージェントが空のディレクトリにいる段階のために、Guren は導入用のスキルを 2 つ、[`gurenjs/agent-skills`](https://github.com/gurenjs/agent-skills) からエージェントのカタログに公開しています。

```bash
# Claude Code
claude plugin marketplace add gurenjs/agent-skills
claude plugin install guren@gurenjs --scope user

# Cursor・Codex・Copilot・OpenCode・Gemini CLI など(Agent Skills CLI)
npx skills add gurenjs/agent-skills
```

インストール先はユーザースコープです。これらのスキルはプロジェクトができる*前*の段階で使うもので、何を作るにしても同じ 2 つだからです。プロジェクトスコープにすると、そのときたまたまいたリポジトリの設定に書き込まれてしまい、すでにハーネスが入っているアプリの共同作業者にまで導入用のスキルを配ることになります。このプラグインは [Agent Plugins v1](https://agent-plugins.org) にも準拠しているので、ルートの `plugin.json` を読むクライアントなら、リポジトリから直接インストールできます。

中身は `guren-new-app`(Guren を説明し、`bunx create-guren-app` で雛形を作って、アプリ側に引き継ぐ)と `guren-harness`(`bunx guren agent:init --target <agents>` を実行し、`guren context` → 編集 → `guren check` → `guren audit` のループを説明する)の 2 つです。ハーネスのルールやスキルは、あえてコピーしていません。それらはアプリ自身の CLI が入れるもので、常にアプリのバージョンと揃っています。このカタログのリポジトリはリリースのたびに Guren のリポジトリから生成されるので、変更は `gurenjs/agent-skills` ではなく Guren のほうに送ってください。

## ハーネスの導入と更新

| コマンド | 説明 | 例 |
|---------|------|-----|
| `agent:init` | 選んだエージェント向けのハーネスを既存のアプリに入れる(既存のファイルはスキップ、`--force` で上書き) | `bunx guren agent:init --target codex,cursor` |
| `agent:sync` | フレームワークが管理するファイル(ルール・スキル・サブエージェント・hooks)を、ディスク上で見つかったすべてのエージェントの分まとめて最新版にする | `bunx guren agent:sync` |

`agent:init --target` には `claude`(デフォルト)・`codex`・`cursor`・`copilot`・`opencode`・`all` を指定できます。`agent:sync` は利用者が持つファイル(`CLAUDE.md`・`AGENTS.md`・`.claude/settings.json`・各 MCP クライアントの設定)を上書きしないので、フレームワークを更新してもカスタマイズは残ります(削除した利用者側のファイルは作り直されます)。MCP や hook の設定がすでにある場合、`agent:init` はファイルを上書きせず、手で追記するためのスニペットを表示します。

フレームワークが管理するファイル(ルール・スキル・サブエージェント・hooks)は、`agent:sync` が上書きします。それがこのコマンドの役目なので、プロジェクト固有のルールは配布されたファイルに書き足さず、別の名前の自分のファイルとして置いてください。上書きは必ず画面に表示されます。最新版と同じファイルはスキップし、内容が違っていたファイルは「置き換えた」とはっきり示します。先に `agent:sync --dry-run` を実行すれば、ファイルを一切変えずに、何が書き込まれ、何が置き換えられ、何が削除候補になるかを確認できます。`agent:init` も `--dry-run` を受け付けるので、`--force` のプレビューとして使えます。

リリースでフレームワークのルールやスキルの名前が変わったり削除されたりしても、古いファイルは配布先のルートにすべて残ったままになります。特に Cursor と Copilot は、古い `.cursor/rules/guren-*.mdc` / `.github/instructions/guren-*.instructions.md` を glob で読み込み続けます。`agent:sync` は、フレームワークが管理する場所にあって今のハーネスに含まれないファイルを一覧にし、`agent:sync --prune` を付けるとそれらを削除します。

削除の対象は、常に**名前**で決まります。

- ルールのルート(`.claude/rules/`、`.agents/rules/`): ハーネスが配布している(または以前配布した)ルールのファイル名だけ
- 各エージェント形式のルール: 最上位にある `guren-*.mdc` / `guren-*.instructions.md` だけ
- スキルのルート(`.claude/skills/`、`.agents/skills/`): ハーネスが配布している(または以前配布した)スキルのディレクトリだけ

配布されたルールの隣(サブディレクトリを含む)に置いた自作のルールファイルや、自分で追加したスキル(`npx skills add` や Agent Plugins のクライアントが同じディレクトリに入れたものを含む)は、一覧にも出ず、削除もされません。例外は、ハーネス自身が配布している名前とぶつかった場合だけです。スキルなら `dev-workflow`・`db-manage`・`scaffold`・`feature`・`guren-api`・`plugin-authoring`・`agent-interface`・`ai-agent`・`github-projects`・`plan-write`・`plan-implement`、ルールならエントリードキュメントに載っているファイル名(大文字と小文字は区別しません)が該当します。Cursor と Copilot では名前の一覧ではなくプレフィックスで判定するので、最上位にある `guren-*.mdc` / `guren-*.instructions.md` が**すべて**該当します。Cursor や Copilot の自作ルールには別のプレフィックスを付けておき、`--prune` の前には一覧を確認してください。
