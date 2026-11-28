# MCP Skills

スキルは、アプリを使う人のエージェントに向けて公開する手順書です。どのツールをいつ、どの順番で呼ぶか、呼び出しが拒否されたらどうするかを書きます。実体は `SKILL.md` を置いたディレクトリで、書式は [Agent Skills](https://agentskills.io/specification) に従います。MCP Skills 拡張に対応したホストには、MCP エンドポイントがそのまま配信します。

ツールの説明に書けるのは、1 回の呼び出しで何が起きるかまでです。返金の手順、似た 2 つのツールのどちらを先に呼ぶか、返信で守る方針のように、複数の呼び出しにまたがる内容はスキルに書きます。

前提として、アプリが [エージェントインターフェース](./agent-interface.md) のツールを `mcpPlugin()` で公開している必要があります。

ここで扱うスキルは、アプリにエージェントをつなぐ利用者のためのものです。[エージェントハーネス](./agent-harness.md)が開発用のコーディングエージェントに入れる `.claude/skills/` とは関係がありません。

## スキルを書く

```bash
bunx guren make:mcp-skill refunds --description "Process a refund per shop policy"
```

このコマンドは `resources/skills/refunds/SKILL.md` を書き出します。

```md
---
name: refunds
description: "Process a refund per shop policy"
---

# Refunds

Write the steps an agent follows. Name the tools it calls in order, and say what to do when one refuses.
```

`name` はディレクトリ名と同じにします。使えるのは英小文字、数字、単独のハイフンで、長さは 1〜64 文字です。`description` は、エージェントがスキルを読み込むかどうかを決めるときに読む 1 行なので、何をするスキルで、どんなときに使うかを書きます。`--description` を省くと仮の文が入るので、書き換えてください。

補助のファイルは `SKILL.md` の隣に置き、`SKILL.md` から相対パスで参照します。エージェントは、スキルに指示されたときだけそのファイルを読みます。

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

`bunx guren codegen` を実行すると、スキルが `.guren/mcp-skills.gen.ts` にまとめられます。Vite の開発サーバーはスキルのディレクトリにあるファイルが変わるたびに codegen をやり直し、scaffold した `build` スクリプトもビルドの前に実行します。API のみのアプリでは、スキルを編集したあとに手動で実行してください。

各スキルには `skill://` で始まるアドレスが付きます。モジュールのスキルでは、モジュール名が先頭に入ります。

| ファイル | アドレス |
|---|---|
| `resources/skills/refunds/SKILL.md` | `skill://refunds/SKILL.md` |
| `resources/skills/refunds/references/policy.md` | `skill://refunds/references/policy.md` |
| `modules/billing/resources/skills/dunning/SKILL.md` | `skill://billing/dunning/SKILL.md` |

スキルのディレクトリより下にある通常のファイルは、種類を問わずすべて公開されます。次のものは公開されません。

- 直下に `SKILL.md` がないディレクトリと、スキルのディレクトリと同じ階層に置いたファイル
- `.DS_Store` のようなドットファイルと、ドットで始まるディレクトリ
- シンボリックリンク

次の 2 つの配置では、あるスキルのファイルが別のスキルの中に入ってしまうため、アプリが起動時に両方のファイルを示すエラーで止まります。

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

モジュールは import で読み込むので、どのデプロイ先のバンドラーでもスキルがバンドルに入り、アプリが実行時にディレクトリを読むことはありません。`mcpPlugin()` の呼び出しに `skills` がまだないときは、`make:mcp-skill` がこの行を表示します。

プラグインは起動時に 1 度だけカタログを作ります。frontmatter が解析できないスキル、`name` か `description` がないスキル、`name` がディレクトリ名と違うスキルはカタログに入らず、起動時に理由が表示されます。

```text
[@guren/plugin-mcp] Skill file "refunds/SKILL.md": SKILL.md frontmatter: line 3: unexpected text after the value (skill skipped)
```

MCP 2026-07-28 で接続し、Skills 拡張に対応しているホストは、`skills/list` でスキルの一覧を取り、`skills/get` で 1 つを読み込みます。それ以外のクライアントからは、同じファイルが通常のリソースとして見えます。各 `SKILL.md` が `resources/list` に並び、どのファイルも `resources/read` で読めます。

スキルの一覧と読み取りには、エンドポイントのほかの読み取りと同じく、呼び出し元ごとのレート制限がかかります。

## スキルを読める範囲

エンドポイントが認証した呼び出し元は、すべてのスキルを読めます。`tools:` のスコープを 1 つも持たないトークンも同じで、ツールは 1 つも呼べませんが、ファイルはどれも読めます。

このため、次の 2 点に気をつけてください。

- スキルのディレクトリに置いたものは、アプリのトークンを持つ全員に公開されます。デプロイの前にディレクトリの中身を確認し、認証情報、内部の URL、顧客のデータは置かないでください。
- スキルは権限を与えず、制限もかけません。読んだトークンでは拒否される呼び出しが書かれていることもあり、エージェントがスキルに従わないこともあります。アプリが守る必要のあるルールは、ルートの[ポリシー](./authorization.md)か[スコープと承認ゲート](./agent-tool-governance.md)に置き、スキルにはその説明を書きます。

## 関連

- [エージェントインターフェース](./agent-interface.md): ツールを宣言して MCP で公開する
- [エージェントツールの権限と監査](./agent-tool-governance.md): スキルに書いた呼び出しにかかるスコープ、承認、監査
- [MCP Apps](./mcp-apps.md): ツールの結果をホストの中でページとして表示する
- [API トークン](./api-tokens.md): ホストが使うトークンの発行と失効
- [CLI](./cli.md): `make:mcp-skill` と `codegen`
