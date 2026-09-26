# 第 2 章: 最初の計画

計画は変更の設計で、コードより先に JSON で書きます。この章では、勉強会の主催について最初の計画をエージェントに書かせ、Guren がそこから描画するレビューページで読みます。

**この章で学ぶこと:**

- 依頼に書くことと、エージェントに質問させること
- 計画の中身をセクションごとに
- レビューページの読み方と、最初に確かめる 5 つの点

## 1. 計画を頼む

第 1 章で起動した Claude Code のセッションに、次を送ります。

> plan-write スキルでこの機能を計画してください。サインインしたユーザーは勉強会を主催でき、勉強会にはタイトル、開始日時、定員があります。主催者は自分の勉強会を編集できます。参加登録はまだ作りません。それは後の計画で扱います。

依頼に書くのは **何を** と **誰が** です。ルート、テーブル、ページはあえて書きません。そこはエージェントの初稿に任せ、レビューページで直します。

`plan-write` スキルはエージェントに、書き始める前にアプリを読ませます (`bunx guren context`、`bunx guren model:list`)。そのうえで、設計を左右する点を質問してきます。たとえば次のような質問です。

- ゲストも勉強会を見られるか、サインインしたユーザーだけか
- 主催者は勉強会を削除できるか
- 定員に上限はあるか

決まっているものには答えてください。答えずに残した質問も失われません。エージェントが仮の答えを添えて計画に書き込み、第 3 章でレビューページから決めます。下の参照用の計画では「ゲストは勉強会を見られるか」を未決のまま残しています。

エージェントはそのあと `docs/plans/meetups/plan.json` を書き、失敗する検査がなくなるまで `bunx guren plan:render --json` を実行します。

**エージェントなしの場合:** 計画を自分で置きます。長いファイルですが、1 行ずつ読む必要はありません。読むのは次の節のレビューページです。

```bash run fallback
mkdir -p docs/plans/meetups
```

<details>
<summary>docs/plans/meetups/plan.json</summary>

```json file=docs/plans/meetups/plan.json fallback
{
  "planVersion": 1,
  "title": "Meetups",
  "summary": "Signed-in users organize meetups with a capacity and edit the ones they organize. Anyone can browse them.",
  "locale": "en",
  "scope": {"goals": ["Organize a meetup", "Edit your own meetup", "Browse meetups"], "nonGoals": ["Registering for a meetup", "Deleting a meetup"]},
  "assumptions": ["Meetups are listed soonest first"],
  "questions": [
    {
      "id": "Q-guests",
      "question": "Can guests browse meetups?",
      "options": [
        {"label": "yes", "consequence": "The list and the meetup page need no sign-in."},
        {"label": "no", "consequence": "The list and the meetup page sit behind the login wall."}
      ],
      "assumed": "yes",
      "affects": ["route.meetups.index", "route.meetups.show"]
    }
  ],
  "models": [
    {
      "id": "model.user",
      "change": {"kind": "existing"},
      "name": "User",
      "table": "users",
      "columns": [{"id": "column.user.id", "name": "id", "change": {"kind": "existing"}, "type": "integer", "nullable": false, "unique": false, "index": false, "primaryKey": true}],
      "relationships": [],
      "fillable": []
    },
    {
      "id": "model.meetup",
      "change": {"kind": "add"},
      "name": "Meetup",
      "table": "meetups",
      "columns": [
        {"id": "column.meetup.id", "name": "id", "change": {"kind": "add"}, "type": "integer", "nullable": false, "unique": false, "index": false, "primaryKey": true},
        {"id": "column.meetup.title", "name": "title", "change": {"kind": "add"}, "type": "string", "nullable": false, "unique": false, "index": false},
        {
          "id": "column.meetup.startsAt",
          "name": "startsAt",
          "columnName": "starts_at",
          "change": {"kind": "add"},
          "type": "string",
          "nullable": false,
          "unique": false,
          "index": true
        },
        {"id": "column.meetup.capacity", "name": "capacity", "change": {"kind": "add"}, "type": "integer", "nullable": false, "unique": false, "index": false},
        {
          "id": "column.meetup.organizerId",
          "name": "organizerId",
          "columnName": "organizer_id",
          "change": {"kind": "add"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": true,
          "references": {"model": "model.user", "column": "id", "onDelete": "cascade"}
        }
      ],
      "relationships": [{"name": "organizer", "type": "belongsTo", "target": "model.user"}],
      "fillable": ["title", "startsAt", "capacity"]
    }
  ],
  "validators": [
    {
      "id": "validator.meetup",
      "change": {"kind": "add"},
      "name": "MeetupPayloadSchema",
      "fields": [
        {"name": "title", "type": "string", "required": true, "rules": ["min 1", "max 120"]},
        {"name": "startsAt", "type": "string", "required": true, "rules": ["min 1"]},
        {"name": "capacity", "type": "integer", "required": true, "rules": ["min 1", "max 500"]}
      ]
    }
  ],
  "controllers": [
    {
      "id": "controller.meetups",
      "change": {"kind": "add"},
      "className": "MeetupController",
      "actions": [
        {
          "id": "action.meetups.index",
          "change": {"kind": "add"},
          "name": "index",
          "authorization": {"middleware": []},
          "response": {"kind": "inertia", "view": "view.meetups.index"},
          "rules": ["Upcoming meetups first."]
        },
        {
          "id": "action.meetups.show",
          "change": {"kind": "add"},
          "name": "show",
          "authorization": {"middleware": []},
          "response": {"kind": "inertia", "view": "view.meetups.show"},
          "rules": []
        },
        {
          "id": "action.meetups.create",
          "change": {"kind": "add"},
          "name": "create",
          "authorization": {"middleware": ["auth"]},
          "response": {"kind": "inertia", "view": "view.meetups.create"},
          "rules": []
        },
        {
          "id": "action.meetups.store",
          "change": {"kind": "add"},
          "name": "store",
          "body": "validator.meetup",
          "authorization": {"middleware": ["auth"]},
          "response": {"kind": "redirect", "to": "/meetups/:id"},
          "rules": ["The organizer is the signed-in user."]
        },
        {
          "id": "action.meetups.edit",
          "change": {"kind": "add"},
          "name": "edit",
          "authorization": {"middleware": ["auth"], "policy": {"id": "policy.meetup", "ability": "update"}},
          "response": {"kind": "inertia", "view": "view.meetups.edit"},
          "rules": []
        },
        {
          "id": "action.meetups.update",
          "change": {"kind": "add"},
          "name": "update",
          "body": "validator.meetup",
          "authorization": {"middleware": ["auth"], "policy": {"id": "policy.meetup", "ability": "update"}},
          "response": {"kind": "redirect", "to": "/meetups/:id"},
          "rules": []
        }
      ]
    }
  ],
  "routes": [
    {
      "id": "route.meetups.index",
      "change": {"kind": "add"},
      "method": "GET",
      "path": "/meetups",
      "name": "meetups.index",
      "action": "action.meetups.index",
      "middleware": [],
      "bind": []
    },
    {
      "id": "route.meetups.create",
      "change": {"kind": "add"},
      "method": "GET",
      "path": "/meetups/create",
      "name": "meetups.create",
      "action": "action.meetups.create",
      "middleware": ["auth"],
      "bind": []
    },
    {
      "id": "route.meetups.store",
      "change": {"kind": "add"},
      "method": "POST",
      "path": "/meetups",
      "name": "meetups.store",
      "action": "action.meetups.store",
      "middleware": ["auth"],
      "bind": []
    },
    {
      "id": "route.meetups.show",
      "change": {"kind": "add"},
      "method": "GET",
      "path": "/meetups/:id",
      "name": "meetups.show",
      "action": "action.meetups.show",
      "middleware": [],
      "bind": [{"param": "id", "model": "model.meetup"}]
    },
    {
      "id": "route.meetups.edit",
      "change": {"kind": "add"},
      "method": "GET",
      "path": "/meetups/:id/edit",
      "name": "meetups.edit",
      "action": "action.meetups.edit",
      "middleware": ["auth"],
      "bind": [{"param": "id", "model": "model.meetup"}]
    },
    {
      "id": "route.meetups.update",
      "change": {"kind": "add"},
      "method": "PUT",
      "path": "/meetups/:id",
      "name": "meetups.update",
      "action": "action.meetups.update",
      "middleware": ["auth"],
      "bind": [{"param": "id", "model": "model.meetup"}]
    }
  ],
  "views": [
    {
      "id": "view.meetups.index",
      "change": {"kind": "add"},
      "page": "meetups/Index",
      "purpose": "List upcoming meetups, soonest first.",
      "props": [{"name": "meetups", "type": "Data.Meetup[]", "resource": "resource.meetup"}],
      "actions": [{"label": "New meetup", "route": "route.meetups.create"}],
      "states": {"empty": "No meetups yet."}
    },
    {
      "id": "view.meetups.show",
      "change": {"kind": "add"},
      "page": "meetups/Show",
      "purpose": "Show a meetup and who organizes it.",
      "props": [{"name": "meetup", "type": "Data.Meetup", "resource": "resource.meetup"}],
      "actions": [{"label": "Edit", "route": "route.meetups.edit"}],
      "states": {}
    },
    {
      "id": "view.meetups.create",
      "change": {"kind": "add"},
      "page": "meetups/Create",
      "purpose": "Organize a meetup.",
      "props": [],
      "form": {
        "validator": "validator.meetup",
        "submitsTo": "route.meetups.store",
        "fields": [
          {"field": "title", "label": "Title", "input": "text"},
          {"field": "startsAt", "label": "Starts at", "input": "datetime"},
          {"field": "capacity", "label": "Capacity", "input": "number"}
        ]
      },
      "actions": [],
      "states": {}
    },
    {
      "id": "view.meetups.edit",
      "change": {"kind": "add"},
      "page": "meetups/Edit",
      "purpose": "Edit a meetup you organize.",
      "props": [{"name": "meetup", "type": "Data.Meetup", "resource": "resource.meetup"}],
      "form": {
        "validator": "validator.meetup",
        "submitsTo": "route.meetups.update",
        "fields": [
          {"field": "title", "label": "Title", "input": "text"},
          {"field": "startsAt", "label": "Starts at", "input": "datetime"},
          {"field": "capacity", "label": "Capacity", "input": "number"}
        ]
      },
      "actions": [],
      "states": {}
    }
  ],
  "resources": [
    {
      "id": "resource.meetup",
      "change": {"kind": "add"},
      "name": "MeetupResource",
      "model": "model.meetup",
      "fields": [{"name": "id", "type": "number"}, {"name": "title", "type": "string"}, {"name": "startsAt", "type": "string"}, {"name": "capacity", "type": "number"}]
    }
  ],
  "policies": [
    {
      "id": "policy.meetup",
      "change": {"kind": "add"},
      "name": "MeetupPolicy",
      "model": "model.meetup",
      "abilities": [{"name": "update", "rule": "The signed-in user organizes the meetup."}]
    }
  ],
  "tasks": [
    {
      "id": "task.meetups",
      "entity": "Meetup",
      "summary": "Organize a meetup and edit your own.",
      "covers": [
        "model.meetup",
        "validator.meetup",
        "controller.meetups",
        "route.meetups.index",
        "route.meetups.create",
        "route.meetups.store",
        "route.meetups.show",
        "route.meetups.edit",
        "route.meetups.update",
        "view.meetups.index",
        "view.meetups.show",
        "view.meetups.create",
        "view.meetups.edit",
        "resource.meetup",
        "policy.meetup"
      ],
      "acceptance": [
        {
          "id": "AC-meetups-1",
          "description": "A signed-in user can organize a meetup.",
          "kind": "success",
          "actor": "user",
          "route": "route.meetups.store",
          "given": [],
          "input": [{"name": "title", "json": "\"Bun night\""}, {"name": "startsAt", "json": "\"2026-10-20T19:00\""}, {"name": "capacity", "json": "20"}],
          "expect": {"status": 303, "database": [{"table": "meetups", "has": [{"name": "title", "json": "\"Bun night\""}]}]}
        },
        {
          "id": "AC-meetups-2",
          "description": "A meetup needs at least one seat.",
          "kind": "validation",
          "actor": "user",
          "route": "route.meetups.store",
          "given": [],
          "input": [{"name": "title", "json": "\"Bun night\""}, {"name": "startsAt", "json": "\"2026-10-20T19:00\""}, {"name": "capacity", "json": "0"}],
          "expect": {"status": 422, "errors": ["capacity"]}
        },
        {
          "id": "AC-meetups-3",
          "description": "A guest cannot organize a meetup.",
          "kind": "unauthenticated",
          "actor": "guest",
          "route": "route.meetups.store",
          "given": [],
          "expect": {"redirect": "/login"}
        },
        {
          "id": "AC-meetups-4",
          "description": "A user cannot edit someone else's meetup.",
          "kind": "forbidden",
          "actor": "user",
          "route": "route.meetups.update",
          "given": ["a meetup organized by another user exists"],
          "expect": {"status": 403}
        },
        {
          "id": "AC-meetups-5",
          "description": "Anyone can see the list of meetups.",
          "kind": "success",
          "actor": "guest",
          "route": "route.meetups.index",
          "given": ["a meetup exists"],
          "expect": {"status": 200}
        },
        {
          "id": "AC-meetups-6",
          "description": "A guest cannot open the edit form.",
          "kind": "unauthenticated",
          "actor": "guest",
          "route": "route.meetups.edit",
          "given": ["a meetup exists"],
          "expect": {"redirect": "/login"}
        },
        {
          "id": "AC-meetups-7",
          "description": "The organizer can edit their meetup.",
          "kind": "success",
          "actor": "user",
          "route": "route.meetups.update",
          "given": ["the user organizes a meetup"],
          "input": [{"name": "title", "json": "\"Bun night 2\""}, {"name": "startsAt", "json": "\"2026-10-20T19:00\""}, {"name": "capacity", "json": "30"}],
          "expect": {"status": 303, "database": [{"table": "meetups", "has": [{"name": "title", "json": "\"Bun night 2\""}]}]}
        }
      ]
    }
  ]
}
```

</details>

## 2. 計画の中身

| セクション | 中身 |
|---|---|
| `scope` | 目標と非目標。1 項目 1 文です |
| `questions` | エージェントが決められなかったことと、仮に選んだ答え |
| `models`、`validators`、`controllers`、`routes`、`views`、`resources`、`policies` | 設計本体。変わるものごとに 1 要素です |
| `tasks` | 受け入れ振る舞い。1 つが 1 つのテストになります |

要素はすべて `id` (`route.meetups.store`) と `change` を持ちます。`change` は `add`、`alter`、`rename`、`drop`、そして計画が参照するだけのものを表す `existing` のどれかです。この計画では、勉強会が指す `model.user` を除いてすべて `add` です。

## 3. レビューページを描画する

```bash run
bunx guren plan:render docs/plans/meetups/plan.json
```

計画をアプリと突き合わせて検査し、`docs/plans/meetups/plan.html` を書きます。このファイルをブラウザで開きます。ページのラベルを日本語にしたいときは、`plan:render` に `--locale ja` を付けます。

```bash manual
open docs/plans/meetups/plan.html
```

ページはネットワークにアクセスしないので、そのままレビュー依頼に添付できます。

![Meetups 計画のレビューページの「Needs attention」パネル。警告が 5 件並んでいます。meetups.store に policy がないという警告が 1 件、ある種類の受け入れ振る舞いがないルートについての警告が 4 件です](../../images/agent-course-needs-attention.png)

## 4. この順番で読む

上から順に 5 つを確かめます。要素ごとのタブは最初は読み飛ばして構いません。何を確かめるか分かってから、細部を見るためのものです。

| # | 見る場所 | 自分に問うこと |
|---|---|---|
| 1 | 目標と非目標 | 頼んだとおりか。余計なものはないか |
| 2 | Needs attention | `fail` はないか。各 `warn` は誤りか、同意できる選択か |
| 3 | 質問 | 仮の答えに同意できるか |
| 4 | Tasks & acceptance | 守りたいルールはすべて振る舞いになっているか |
| 5 | Tasks & acceptance | policy の後ろにあるルートすべてに、policy が通すユーザーの `success` 振る舞いがあるか |

大事なのは最後の 2 行です。振る舞いになっていないルールにはテストがなく、第 4 章のループはテストが証明したものしか数えません。「主催者だけが編集できる」は `forbidden` の振る舞いとして書かれていなければ、何も確かめません。

5 行目はページが助けてくれない唯一の点です。全員を拒否する policy は、`forbidden` のテストをすべて通してしまいます。それを捕まえられるのは、通してよいユーザーのテストだけです。ページは `forbidden`、`unauthenticated`、`validation` の振る舞いが欠けていると警告しますが、この点は警告しません。

この計画の警告は次のとおりです。

| 警告 | 判断 |
|---|---|
| `meetups.store` に policy がない | 選択です。サインインしたユーザーなら誰でも勉強会を主催できます。このままにします |
| `meetups.create` と `meetups.update` に `unauthenticated`、`meetups.edit` に `forbidden`、`meetups.update` に `validation` の振る舞いがない | 誤りです。テストのないルールです |

5 行目でもう 1 つ見つかります。`meetups.update` には主催者の success 振る舞い (`AC-meetups-7`) がありますが、`meetups.edit` にはありません。

これらは未決の質問と一緒に第 3 章で直します。

## 5. 自分の計画か、参照用の計画か

ここから先の章は、上の参照用の計画の要素を名指しします。たとえば `route.meetups.edit`、`AC-meetups-7`、ステップ `task/entity/model.meetup/http` です。エージェントが書いた計画では id が変わります。どちらかを選んでください。

- **自分の計画を使い続ける。** 以降の章の名前は例として読み、自分の計画で対応する要素を探します。チェック表はどの計画にも使えます。
- **参照用の計画に切り替える。** 上の **エージェントなしの場合** のブロックで `docs/plans/meetups/plan.json` を上書きします。以降は名前、コマンド、出力がすべてコースと一致します。

初めて通すなら切り替えを勧めます。**エージェントなしの場合** のブロックは前のブロックの結果を前提にしているので、第 6 章までは、ここが合流しやすい最後の地点です。

## 6. 下書きをコミットする

下書きもほかの文書と同じです。コミットして、第 3 章のレビューをきれいなツリーから始めます。

```bash run
git add docs/plans
git commit -m "docs: draft the meetups plan"
```

## いまいる場所

- `docs/plans/meetups/plan.json`。まだ誰も承認していない下書きです。
- 描画したレビューページ。git の対象外です。
- 直すものの一覧。未決の質問が 1 つ、足りない振る舞いが 5 つです。

## よくあるつまずき

- **エージェントがコードを書き始める。** 止めて「計画だけ」と伝えてください。スキルは計画で終わりますが、依頼が作業の指示に読めると、エージェントが実装に流れることがあります。
- **`plan:render` がスキーマエラーを出す。** JSON が計画のスキーマに合っていません。メッセージがフィールドを示すので、そのままエージェントに返します。
- **エージェントが `plan:approve` を実行した。** 承認は自分の仕事です。`approvals.json` を削除し、エージェントにそう伝えてください。

## 演習

1. レビューページの **Entity** メニューで 1 つのエンティティに絞り、**Changes only** をオンにしてください。何が消えましたか。ほとんどが追加の計画で、この表示が役立つのはなぜですか。
2. **Tasks & acceptance** から振る舞いを 1 つ選び、それがどんなテストになるかを 1 文で書いてください。本物は第 4 章で出てきます。

## 次へ

[第 3 章: レビューと承認](./03-review-and-approve.md) では、質問に答え、足りない振る舞いを足し、計画を承認します。
