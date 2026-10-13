# 実装計画の書き方

このページでは、計画のファイルそのもの（セクション、要素の id と change、受け入れ振る舞い、質問、コマンド）を説明します。計画を描画し、承認し、実装する流れは[実装計画](./implementation-plans.md)にあり、このページで使う言葉（要素、振る舞い、ステップ）はその[用語](./implementation-plans.md#用語)の表で定義しています。

## ドキュメントの構成

| フィールド | 中身 |
|---|---|
| `planVersion` | `1` |
| `title`、`summary`、`locale` | 計画の題と要約、本文の言語 (`en`、`ja`) |
| `scope` | `goals` と `nonGoals` |
| `assumptions`、`questions` | 指示なしに決めたことと、決めきれなかったこと |
| `models`、`validators`、`controllers`、`routes`、`views`、`resources`、`policies`、`sideEffects` | 設計の本体。要素の種類ごとに 1 セクション |
| `flows` | 計画で足すものの中を、リクエストがどう流れるか。ノードとエッジで書く |
| `commands` | 変更の前に実行しておく `guren add attachments` などのコマンド |
| `tasks` | スライスごとに達成すべきことと、その受け入れ振る舞い |
| `hints` | `task/entity/model.tag before task/entity/model.comment` のような、順序についての助言 |
| `baseline` | `plan:approve` が書く。手では書かない |

どのセクションも省略できます。省略したセクションと空のセクションは、同じ計画として扱われます。

## id と change

要素はすべて `id` と `change` を持ちます。id の名前空間は計画全体で 1 つです。先頭は英字にし、あとには英数字と `_`、`.`、`:`、`-` を使えます。慣例では、セクション名と名前をつなげて書きます (`model.comment`、`route.comments.store`)。要素どうしはこの id で互いを参照し、あとで改訂するときも要素は id だけで指すので、一度決めた id は変えないでください。

| `change.kind` | 意味 |
|---|---|
| `existing` | 参照するだけで変えない |
| `add` | 新しく足す |
| `alter` | その場で変える |
| `rename` | 名前を変える。`from` は旧名 (モデルならクラス名、カラムならプロパティ名、ルートならルート名) |
| `drop` | 取り除く。`reason` に理由を書く |

既存のテーブルやカラムに `alter`、`rename`、`drop` を使う場合は、既存の行をどう扱うかを `dataMigration` に書きます。書けるのは `{ "kind": "none", "reason": "…" }` か、`description` を付けた `backfill` または `manual` です。これを書いていない計画は承認されません。

```text
  column.post.summary: Column "summary" of "Post" is a "rename" on an existing table and states no dataMigration.
```

モデルに並べるのは、計画で変えるカラムと参照するカラムだけです。次の例は、例の計画で新しく足す `Comment` モデルを、5 つのカラムのうち 2 つに絞って示したものです。

```json
{
  "id": "model.comment",
  "change": { "kind": "add" },
  "name": "Comment",
  "table": "comments",
  "columns": [
    {
      "id": "column.comment.body",
      "name": "body",
      "change": { "kind": "add" },
      "type": "text",
      "nullable": false,
      "unique": false,
      "index": false
    },
    {
      "id": "column.comment.postId",
      "name": "postId",
      "columnName": "post_id",
      "change": { "kind": "add" },
      "type": "integer",
      "nullable": false,
      "unique": false,
      "index": true,
      "references": { "model": "model.post", "column": "id", "onDelete": "cascade" }
    }
  ],
  "relationships": [
    { "name": "post", "type": "belongsTo", "target": "model.post" },
    { "name": "author", "type": "belongsTo", "target": "model.user" }
  ],
  "fillable": ["body"]
}
```

カラム型は、Drizzle のビルダー名ではなく抽象的な型名で書きます。使えるのは `string`、`text`、`integer`、`number`、`decimal`、`boolean`、`date`、`datetime`、`json`、`uuid` の 10 種類です。`datetime` には `withTimezone` を、`decimal` には `precision` と `scale` を指定できます。

ほかのセクションも同じような形です。コントローラーにはアクションを並べ、各アクションに `body`、`params`、`query` で使う validator、`authorization` (ミドルウェアと Policy の ability)、`response` (Inertia のビュー、リダイレクト、Resource)、業務ルールを文章で書いた `rules` を書きます。ルートにはメソッド、パス、ルート名、アクションの id、ミドルウェア、`bind` を書きます。ビューにはページ id と props を書きます。フォームのフィールドにはルールを書き直さず、validator のフィールドを指定します。アプリケーションモジュールに属する要素には `module` を付けます。

## 受け入れ振る舞い

タスクの意図には、対象のエンティティ、そのタスクが受け持つ要素、動作を確かめる振る舞いを書きます。

```json
{
  "id": "AC-comments-4",
  "description": "A user cannot delete someone else's comment.",
  "kind": "forbidden",
  "actor": "user",
  "route": "route.comments.destroy",
  "given": ["a comment written by another user exists"],
  "expect": { "status": 403 }
}
```

`kind` には `success`、`validation`、`unauthenticated`、`forbidden`、`not-found`、`state` のどれかを書きます。検査はこの種類ごとに振る舞いを数え、validator があるのに `validation` の振る舞いがないルートや、認証が必要なのに `unauthenticated` の振る舞いがないルートを報告します。

`expect` には `status`、`redirect`、`inertia`、`errors`、`database` を書けます。リクエストの `input` とデータベースの値は、`{ "name": "body", "json": "\"Nice post\"" }` のように値を JSON テキストとして書きます。

振る舞いは 1 つずつテストになり、テスト名には角括弧で囲んだ id を入れます。受け入れ振る舞いの id は `AC-` で始めてください。計画にない `AC-` の id が角括弧で書かれていると `plan:verify` が報告するので、打ち間違いに気づけます。

```ts
test("[AC-comments-4] a user cannot delete someone else's comment", async () => {
  const comment = await Comment.forceCreate({ body: 'Mine', postId: post.id, userId: author.id })
  await http.actingAs(reader).delete(`/comments/${comment!.id}`).assertStatus(403)
})
```

Guren は、GET 以外のリクエストに対するリダイレクトを 303 で返します。フォーム送信後にリダイレクトすることを期待する振る舞いには、`"status": 303` と書いてください。

## 質問

質問には、書き手が一人では決めきれなかった判断を書きます。選択肢、計画が仮に選んだもの、答えが変わったときに影響を受ける要素を並べます。

```json
{
  "id": "Q-delete",
  "question": "Does deleting a comment remove the row?",
  "options": [
    { "label": "hard delete", "consequence": "The row is removed; no deleted_at column." },
    { "label": "soft delete", "consequence": "A deleted_at column is added and lists filter on it." }
  ],
  "assumed": "hard delete",
  "affects": ["model.comment", "action.comments.destroy"]
}
```

質問が残っている計画は承認できません。答えが出たら計画を編集して反映します。答えに沿って要素を直し、質問を消して、決めたことを `assumptions` に残してください。承認前の計画は、`plan.json` を直接編集して変えるのが普通です。

## コマンド

計画の `commands` は `plan:next` が実装エージェントに渡し、エージェントは書かれたとおりに実行します。そのため、書けるのは Guren のジェネレーターだけです。

```json
{ "id": "command.attachments", "command": "guren add attachments", "reason": "Comments take images." }
```

検査を通るのは、`guren <subcommand>` か `bunx guren <subcommand>` の形で、サブコマンドが `make:migration` 以外の `make:*`、`lang:publish`、`add plugin` 以外の `add <blueprint>` のどれかであるコマンドです。引数に使えるのは文字、数字、`_-.,:/=@+%` で、空白を含む値は一重引用符か二重引用符で囲みます (`--fields "title:string,body:text?"`)。シェルの演算子、`$`、バックスラッシュ、閉じていない引用符があると検査は失敗します。絶対パスの引数や、`..` でアプリケーションの外に出る引数も失敗します (`--path /etc`、`--app=../other`)。

この検査で制限しているのはシェルの構文とジェネレーターの書き込み先で、`--force` などジェネレーターごとのその他のフラグは判断しません。ここに挙げた以外のコマンドも失敗します。`bun run db:migrate` は計画に書くものではなく、`data` ステップの検証コマンドとして実行されます。

この検査が失敗している間は `plan:approve` が承認を拒否し、こうしたコマンドを含む計画には、下書きでも承認済みでも `plan:next` がステップを渡しません。
