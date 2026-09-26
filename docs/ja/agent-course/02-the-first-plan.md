# 第 2 章: 最初の計画

計画とは、変更の設計をコードより先に JSON で書いたものです。この章では、勉強会を主催する機能について最初の計画をエージェントに書いてもらい、Guren が計画から描画するレビューページで中身を読みます。

**この章で学ぶこと:**

- 依頼に書いておくことと、エージェントからの質問に任せること
- 計画の各セクションに書かれる内容
- レビューページの読み方と、最初に確かめる 5 つの点

## 1. 計画を頼む

第 1 章で起動した Claude Code のセッションに、次のプロンプトを送ります。

```text
plan-write スキルでこの機能を計画してください。サインインしたユーザーは勉強会を主催でき、勉強会にはタイトル、開始日時、定員があります。主催者は自分の勉強会を編集できます。参加登録はまだ作りません。それは後の計画で扱います。
```

依頼には **何を** 作り、**誰が** 使うのかを書きます。ルート、テーブル、ページはあえて書かず、エージェントの初稿に任せてレビューページで直します。

エージェントは `plan-write` スキルに従い、計画を書き始める前にアプリの中身を読んで (`bunx guren context`、`bunx guren model:list`)、設計を左右する点を質問してきます。たとえば次のような質問です。

- ゲストも勉強会を見られるか、サインインしたユーザーだけか
- 主催者は勉強会を削除できるか
- 定員に上限はあるか

すでに決めている点には答えてください。答えなかった質問は、エージェントが仮の答えを添えて計画に残しておくので、第 3 章でレビューページから決められます。下の参照用の計画では、「ゲストも勉強会を見られるか」を未決のまま残しています。

そのあとエージェントは `docs/plans/meetups/plan.json` を書き、`bunx guren plan:render --json` の検査で失敗がなくなるまで直し続けます。

**エージェントなしの場合:** 次の計画ファイルを手で作成します。長いファイルですが、中身はこのあとレビューページで読むので、ここで 1 行ずつ読む必要はありません。

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
| `scope` | 目標と非目標。1 項目を 1 文で書きます |
| `questions` | エージェントが決められなかった点と、仮に選んだ答え |
| `models`、`validators`、`controllers`、`routes`、`views`、`resources`、`policies` | 設計の本体。変更する対象 1 つにつき 1 要素です |
| `tasks` | 受け入れ振る舞い。振る舞い 1 つが 1 つのテストになります |

どの要素にも `id` (`route.meetups.store` など) と `change` があります。`change` の値は `add`、`alter`、`rename`、`drop` のいずれかで、計画から参照するだけの要素には `existing` を使います。この計画では、勉強会から参照している `model.user` 以外はすべて `add` です。

## 3. レビューページを描画する

```bash run
bunx guren plan:render docs/plans/meetups/plan.json
```

実行すると、計画がアプリの現状と照らし合わせて検査され、`docs/plans/meetups/plan.html` が書き出されます。このファイルをブラウザで開いてください。ページのラベルを日本語で表示したい場合は、`plan:render` に `--locale ja` を付けます。

```bash manual
open docs/plans/meetups/plan.html
```

このページは外部へのネットワーク通信を行わないため、ファイルのままレビュー依頼に添付できます。

![Meetups 計画のレビューページの「Needs attention」パネル。警告が 5 件並んでいます。内訳は、meetups.store に policy がないという警告が 1 件と、特定の種類の受け入れ振る舞いが欠けているルートについての警告が 4 件です](../../images/agent-course-needs-attention.png)

## 4. この順番で読む

次の 5 つを上から順に確かめます。要素ごとのタブは、確かめたい点が決まってから細部を見るためのものなので、最初は読み飛ばして構いません。

| # | 見る場所 | 確かめること |
|---|---|---|
| 1 | 目標と非目標 | 頼んだとおりの内容で、余計なものが入っていないか |
| 2 | Needs attention | 失敗 (`fail`) がないか。警告 (`warn`) はそれぞれ誤りか、それとも同意できる選択か |
| 3 | 質問 | 仮に選ばれた答えのそれぞれに同意できるか |
| 4 | Tasks & acceptance | 守りたいルールがすべて振る舞いになっているか |
| 5 | Tasks & acceptance | policy で守られたルートのすべてに、policy が許可するユーザーの `success` 振る舞いがあるか |

最後の 2 行は特に重要です。振る舞いになっていないルールにはテストが作られず、第 4 章のループはテストで確かめられたことしか完了として数えません。たとえば「主催者だけが編集できる」というルールも、`forbidden` の振る舞いとして書いておかなければ、どこでも確かめられません。

5 行目は、ページが警告を出さない唯一の項目です。ページは `forbidden`、`unauthenticated`、`validation` の振る舞いが欠けていれば警告しますが、5 行目の点については何も言いません。全員を拒否する policy は `forbidden` のテストをすべて通ってしまうため、許可されるべきユーザーのテストがないと、この誤りは見つかりません。

この計画で出る警告と、それぞれの判断は次のとおりです。

| 警告 | 判断 |
|---|---|
| `meetups.store` に policy がない | 意図した選択です。サインインしたユーザーなら誰でも勉強会を主催できるので、このままにします |
| `meetups.create` と `meetups.update` に `unauthenticated`、`meetups.edit` に `forbidden`、`meetups.update` に `validation` の振る舞いがない | 誤りです。どれもまだテストのないルールです |

5 行目の確認で、さらに 1 つ見つかります。`meetups.update` には主催者の `success` 振る舞い (`AC-meetups-7`) がありますが、`meetups.edit` にはありません。

これらは、未決の質問とあわせて第 3 章で直します。

## 5. 自分の計画か、参照用の計画か

ここから先の章では、`route.meetups.edit`、`AC-meetups-7`、ステップ `task/entity/model.meetup/http` のように、上の参照用の計画の要素を名前で示します。エージェントが書いた計画では id が異なるので、次のどちらかを選んでください。

- **自分の計画を使い続ける。** 以降の章に出てくる名前は例として読み、自分の計画の中で対応する要素を探しながら進めます。チェック表はどの計画にも使えます。
- **参照用の計画に切り替える。** 上の **エージェントなしの場合** のブロックの内容で `docs/plans/meetups/plan.json` を上書きします。以降は、名前もコマンドも出力も、すべて講座の記述と一致します。

初めて講座を進めるなら、切り替えをお勧めします。**エージェントなしの場合** のブロックは前のブロックの結果を前提にしているため、ここを過ぎると第 6 章まで簡単には合流できません。

## 6. 下書きをコミットする

計画の下書きも、ほかの文書と同じようにコミットしておきます。こうしておけば、第 3 章のレビューを変更のないきれいなツリーから始められます。

```bash run
git add docs/plans
git commit -m "docs: draft the meetups plan"
```

## ここまでの状態

- `docs/plans/meetups/plan.json`。まだ誰も承認していない下書きです。
- 描画したレビューページ。git の対象外です。
- 直すものの一覧。未決の質問が 1 つ、足りない振る舞いが 5 つです。

## よくあるつまずき

- **エージェントがコードを書き始める。** 止めて「計画だけ」と伝えてください。スキル自体は計画を書いたところで終わりますが、依頼が作業の指示のように読めると、エージェントがそのまま実装に進んでしまうことがあります。
- **`plan:render` がスキーマエラーを出す。** JSON が計画のスキーマに合っていません。エラーメッセージに問題のフィールドが出ているので、そのままエージェントに伝えてください。
- **エージェントが `plan:approve` を実行した。** 承認は読者が行うもので、エージェントに実行させてはいけません。`approvals.json` を削除し、そのことをエージェントに伝えてください。

## 演習

1. レビューページの **Entity** メニューで 1 つのエンティティに絞り込み、**Changes only** をオンにしてください。何が表示されなくなりましたか。また、ほとんどが追加で占められる計画で、この表示が役立つのはなぜでしょうか。
2. **Tasks & acceptance** から振る舞いを 1 つ選び、それがどんなテストになるかを 1 文で書いてください。実際のテストは第 4 章で出てきます。

## 次へ

[第 3 章: レビューと承認](./03-review-and-approve.md) では、未決の質問に答えて足りない振る舞いを加え、計画を承認します。
