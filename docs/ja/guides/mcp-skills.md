# MCP Skills

スキルは、アプリを使う人のエージェントに向けて公開する手順書です。どのツールをいつ、どの順番で呼ぶか、呼び出しが拒否されたらどうするかを書きます。実体は `SKILL.md` を置いたディレクトリで、書式は [Agent Skills](https://agentskills.io/specification) に従います。MCP Skills 拡張に対応したホストには、MCP エンドポイントがそのまま配信します。

ツールの説明には、1 回の呼び出しで何が起きるかを書きます。返金の手順、似た 2 つのツールのどちらを先に呼ぶか、返信で守る方針のように、複数の呼び出しにまたがる内容はスキルにまとめます。

スキルを配信するのは `mcpPlugin()` です。設定の手順は[エージェントインターフェース](./agent-interface.md)にあります。ツールを 1 つも公開していないアプリでも、スキルは公開できます。

ここで扱うスキルは、アプリにエージェントをつなぐ利用者のためのものです。[エージェントハーネス](./agent-harness.md)が開発用のコーディングエージェントに入れる `.claude/skills/` とは関係がありません。

## スキルを書く

```bash
bunx guren make:mcp-skill refunds --description "Process a refund per shop policy"
```

このコマンドは `resources/skills/refunds/SKILL.md` を書き出します。

```md
---
name: "refunds"
description: "Process a refund per shop policy"
---

# Refunds

Write the steps an agent follows. Name the tools it calls in order, and say what to do when one refuses.
```

`name` はディレクトリ名と同じにします。英小文字と数字を 1〜64 文字で書き、区切りにはハイフンを 1 つずつ挟めます。`description` は、エージェントがスキルを読み込むかどうかを決めるときに読む 1 行なので、何をするスキルで、どんなときに使うかを書きます。`--description` を省くと仮の文が入るので、書き換えてください。どちらの値も引用符付きで書き出されるため、`no` や `123` のような名前も文字列のまま読まれます。

補助のファイルは `SKILL.md` の隣に置き、`SKILL.md` から相対パスで参照します。ホストは先に `SKILL.md` を読み込み、エージェントが参照をたどったときに残りのファイルを取得します。

```tree
resources/skills/
└── refunds/
    ├── SKILL.md
    └── references/
        └── policy.md
```

モジュールのスキルはモジュールのディレクトリに置きます。`--module` を付けてください。

```bash
bunx guren make:mcp-skill dunning --module billing
```

この場合は `modules/billing/resources/skills/dunning/SKILL.md` が書き出されます。

## 公開されるファイル

`bunx guren codegen` を実行すると、スキルが `.guren/mcp-skills.gen.ts` にまとめられます。Vite の開発サーバーが動いている間は、スキルのディレクトリにあるファイルが変わるたびに作り直され、scaffold した `build` スクリプトも最初に codegen を実行します。API のみのアプリには Vite がなく、`dev` スクリプトが起動時に 1 度 codegen を実行するだけです。スキルを編集したあとと、新しく clone した環境で `typecheck` や `build` を実行する前には、`bun run codegen` を実行してください。

各スキルには `skill://` で始まるアドレスが付きます。モジュールのスキルでは、モジュール名が先頭に入ります。

| ファイル | アドレス |
|---|---|
| `resources/skills/refunds/SKILL.md` | `skill://refunds/SKILL.md` |
| `resources/skills/refunds/references/policy.md` | `skill://refunds/references/policy.md` |
| `modules/billing/resources/skills/dunning/SKILL.md` | `skill://billing/dunning/SKILL.md` |

スキルのディレクトリより下にある通常のファイルは、種類を問わずすべてまとめられます。次のものは含まれません。

- 直下に `SKILL.md` がないディレクトリと、スキルのディレクトリと同じ階層に置いたファイル。ファイル名は大文字と小文字を区別するので、`skill.md` と書いた場合は警告が出ます
- `.DS_Store` のようなドットファイルと、ドットで始まるディレクトリ
- シンボリックリンク。スキルのディレクトリや `resources/skills` そのものがリンクの場合も含みます

次の 2 つの配置は、あるスキルのファイルが別のスキルの中に入ってしまうため、受け付けられません。codegen が警告を出し、アプリは起動時に両方のファイルを示すエラーで止まります。

- 別のスキルのディレクトリより下に `SKILL.md` を置く
- スキルを持つモジュールと同じ名前のスキルをルートに置く（`billing` モジュールにスキルがあるときの `resources/skills/billing/` など）

## スキルを配信する

`mcpPlugin()` に、生成されたモジュールを指定します。

```ts
import { mcpPlugin } from '@guren/plugin-mcp'

mcpPlugin({
  skills: {
    files: () => import('@/.guren/mcp-skills.gen'),
  },
})
```

生成されたモジュールは import されるので、デプロイ用のバンドルにそのまま入り、実行時に `resources/skills/` を読むことはありません。ソースにこのモジュールの名前が出てくると、スキルがまだ 1 つもなくても codegen がモジュールを書き出すため、新しく clone した環境でも import が解決されます。`mcpPlugin()` のどの呼び出しにも `skills` がないときは、`make:mcp-skill` がこの行を表示します。

プラグインは起動時に 1 度だけカタログを作ります。frontmatter が解析できないスキル、`name` か `description` がないスキル、`name` がディレクトリ名と違うスキルはカタログに入らず、起動時に理由が表示されます。

```text
[@guren/plugin-mcp] Skill file "refunds/SKILL.md": SKILL.md frontmatter: line 3: unexpected text after the value (skill skipped)
```

MCP 2026-07-28 で接続し、Skills 拡張に対応しているホストは、`skills/list` と `skills/get` でスキルを見つけ、`resources/read` でファイルを読みます。それ以外のクライアントからは、同じファイルが通常のリソースとして見えます。各 `SKILL.md` が `resources/list` に並び、どのファイルも `resources/read` で読めます。

スキルの一覧と読み取りには、エンドポイントのほかの読み取りと同じく、呼び出し元ごとのレート制限がかかります。`rateLimit: false` を設定している場合はかかりません。

## スキルを読める範囲

エンドポイントが認証した呼び出し元は、すべてのスキルを読めます。`tools:` のスコープを 1 つも持たないトークンも同じで、ツールは 1 つも呼べませんが、ファイルはどれも読めます。

このため、次の 2 点に気をつけてください。

- スキルのディレクトリに置いたものは、アプリのトークンを持つ全員に公開されます。デプロイの前にディレクトリの中身を確認し、認証情報、内部の URL、顧客のデータは置かないでください。
- スキルは権限を与えず、制限もかけません。スキルに手順を書いても、そのツールを呼ぶにはトークンに必要なスコープが要りますし、エージェントがスキルに従わないこともあります。アプリが守る必要のあるルールは、ルートの[ポリシー](./authorization.md)か[スコープと承認ゲート](./agent-tool-governance.md)に置き、スキルにはその説明を書きます。

## チェックが守るもの

`bunx guren check` は、アプリにスキルか生成済みのモジュールがあるとき、またはソースがモジュールを import しているときに、スキルを読みます。スキルが配信されるかどうかは、エンドポイントが起動時に使うのと同じカタログのコードで判定するので、チェックとサーバーの結果は一致します。

| チェック | 失敗または警告になる条件 |
|---|---|
| `mcp-skill-frontmatter:<file>` | エンドポイントがスキルをカタログに入れない。frontmatter がない、`name` か `description` がない、`name` がディレクトリ名と違う、のいずれか。 |
| `mcp-skill-manifest:<file>` | `skill.md` のように、マニフェストのファイル名の大文字と小文字が違う。そのディレクトリは公開されない。 |
| `mcp-skill-namespace:<file>` | 別のスキルのディレクトリより下に `SKILL.md` がある。または、スキルを持つモジュールと同じ名前のスキルがルートにある。 |
| `mcp-skill-limit:<file>` | 1 つのスキルが 512 ファイルか 16 MiB を超えている。どのホストも受け付けることになっている大きさの上限。 |
| `mcp-skills-stale` | `.guren/mcp-skills.gen.ts` がないか、ファイルの内容と違っていて、エンドポイントが古い内容を配信する。`check --fix` が codegen を実行する。 |
| `mcp-skills-unserved` | スキルがあるのに、`skills` を渡している `mcpPlugin()` の呼び出しがない（警告）。オプションを読み切れない呼び出しは、未検証として報告する。 |
| `mcp-skill-host-limit` | テキストファイルが 100 KB、スキルが 400 KB、スキルの数が 100 を超えている。Claude Code が文書にしている上限（参考扱いで、`check --ci` と `gate` は数えない）。 |

`bunx guren audit` は、公開されるスキルのテキストファイルにも、ソースファイルと同じ規則で認証情報の埋め込みがないかを調べます。`bunx guren tool:list` は、エンドポイントが配信するスキルをツールの下に表示し、`--json` では `skills` に入れます。

## 関連

- [エージェントインターフェース](./agent-interface.md): ツールを宣言して MCP で公開する
- [エージェントツールの権限と監査](./agent-tool-governance.md): スキルに書いた呼び出しにかかるスコープ、承認、監査
- [MCP Apps](./mcp-apps.md): ツールの結果をホストの中でページとして表示する
- [API トークン](./api-tokens.md): ホストが使うトークンの発行と失効
- [CLI](./cli.md): `make:mcp-skill` と `codegen`
