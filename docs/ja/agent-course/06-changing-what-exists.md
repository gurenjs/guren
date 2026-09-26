# 第 6 章: 既存のコードを変える計画

1 本目の計画は追加だけで済みましたが、参加登録はそうはいきません。勉強会が自身への登録を把握し、勉強会のページに空き席を表示するには、すでに受け入れたコードに手を入れる必要があります。この章ではその変更を計画し、承認します。今回は「内容が正しいか」に加えて「ほかにどこへ影響するか」も確かめるので、レビューは一段難しくなります。

**この章で学ぶこと:**

- 計画の中で、追加するものと変更するもの (`alter`) を区別する書き方
- **Impact** (変更される要素に依存するコードの一覧) の読み方
- 承認時に `alter` について警告が出る理由と、警告を受けて確かめること

## 1. 計画を頼む

Claude Code のセッションに、次のプロンプトを送ります。

```text
plan-write スキルで参加登録を計画してください。サインインしたユーザーは勉強会に参加登録でき、自分の登録を取り消せます。勉強会は定員を超えて登録を受け付けず、勉強会のページには空き席の数を表示します。
```

エージェントは `guren context Meetup` を通じて第 5 章でできた `docs/entities/Meetup.md` も読むので、既存のルールを把握したうえで計画を立てます。今回は、満席の勉強会に登録しようとしたときにどうするか、という質問を 1 つ未決のまま残してください。

**エージェントなしの場合:**

```bash run fallback
mkdir -p docs/plans/registrations
```

<details>
<summary>docs/plans/registrations/plan.json</summary>

```json file=docs/plans/registrations/plan.json fallback
{
  "planVersion": 1,
  "title": "Registrations",
  "summary": "Signed-in users register for a meetup until it is full and cancel their own registration. The meetup page shows the seats left.",
  "locale": "en",
  "scope": {"goals": ["Register for a meetup", "Cancel your own registration", "See the seats left"], "nonGoals": ["Paid tickets", "Registering someone else"]},
  "assumptions": ["The organizer can register for their own meetup"],
  "questions": [
    {
      "id": "Q-full",
      "question": "What happens when someone registers for a full meetup?",
      "options": [
        {"label": "refuse", "consequence": "No row is written and the page says the meetup is full."},
        {"label": "waitlist", "consequence": "A waitlisted registration is written and promoted when someone cancels."}
      ],
      "assumed": "refuse",
      "affects": ["model.registration", "action.registrations.store"]
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
      "change": {"kind": "alter"},
      "name": "Meetup",
      "table": "meetups",
      "columns": [
        {
          "id": "column.meetup.id",
          "name": "id",
          "change": {"kind": "existing"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": false,
          "primaryKey": true
        }
      ],
      "relationships": [{"name": "registrations", "type": "hasMany", "target": "model.registration"}],
      "fillable": []
    },
    {
      "id": "model.registration",
      "change": {"kind": "add"},
      "name": "Registration",
      "table": "registrations",
      "columns": [
        {
          "id": "column.registration.id",
          "name": "id",
          "change": {"kind": "add"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": false,
          "primaryKey": true
        },
        {
          "id": "column.registration.meetupId",
          "name": "meetupId",
          "columnName": "meetup_id",
          "change": {"kind": "add"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": true,
          "references": {"model": "model.meetup", "column": "id", "onDelete": "cascade"}
        },
        {
          "id": "column.registration.userId",
          "name": "userId",
          "columnName": "user_id",
          "change": {"kind": "add"},
          "type": "integer",
          "nullable": false,
          "unique": false,
          "index": true,
          "references": {"model": "model.user", "column": "id", "onDelete": "cascade"}
        }
      ],
      "relationships": [{"name": "meetup", "type": "belongsTo", "target": "model.meetup"}, {"name": "user", "type": "belongsTo", "target": "model.user"}],
      "fillable": [],
      "indexes": [{"columns": ["meetupId", "userId"], "unique": true}]
    }
  ],
  "controllers": [
    {
      "id": "controller.meetups",
      "change": {"kind": "alter"},
      "className": "MeetupController",
      "actions": [
        {
          "id": "action.meetups.show",
          "change": {"kind": "alter"},
          "name": "show",
          "authorization": {"middleware": []},
          "response": {"kind": "inertia", "view": "view.meetups.show"},
          "rules": ["Pass the signed-in user's registration, if any."]
        }
      ]
    },
    {
      "id": "controller.registrations",
      "change": {"kind": "add"},
      "className": "RegistrationController",
      "actions": [
        {
          "id": "action.registrations.store",
          "change": {"kind": "add"},
          "name": "store",
          "authorization": {"middleware": ["auth"]},
          "response": {"kind": "redirect", "to": "/meetups/:id"},
          "rules": ["The registrant is the signed-in user.", "A full meetup writes no row.", "Registering twice writes no second row."]
        },
        {
          "id": "action.registrations.destroy",
          "change": {"kind": "add"},
          "name": "destroy",
          "authorization": {"middleware": ["auth"], "policy": {"id": "policy.registration", "ability": "delete"}},
          "response": {"kind": "redirect", "to": "/meetups/:meetupId"},
          "rules": []
        }
      ]
    }
  ],
  "routes": [
    {
      "id": "route.meetups.show",
      "change": {"kind": "existing"},
      "method": "GET",
      "path": "/meetups/:id",
      "name": "meetups.show",
      "action": "action.meetups.show",
      "middleware": [],
      "bind": [{"param": "id", "model": "model.meetup"}]
    },
    {
      "id": "route.registrations.store",
      "change": {"kind": "add"},
      "method": "POST",
      "path": "/meetups/:id/registrations",
      "name": "registrations.store",
      "action": "action.registrations.store",
      "middleware": ["auth"],
      "bind": [{"param": "id", "model": "model.meetup"}]
    },
    {
      "id": "route.registrations.destroy",
      "change": {"kind": "add"},
      "method": "DELETE",
      "path": "/registrations/:id",
      "name": "registrations.destroy",
      "action": "action.registrations.destroy",
      "middleware": ["auth"],
      "bind": [{"param": "id", "model": "model.registration"}]
    }
  ],
  "views": [
    {
      "id": "view.meetups.show",
      "change": {"kind": "alter"},
      "page": "meetups/Show",
      "purpose": "Show a meetup with the seats left, and a button to register or cancel.",
      "props": [{"name": "meetup", "type": "Data.Meetup", "resource": "resource.meetup"}, {"name": "registrationId", "type": "number | null"}],
      "actions": [{"label": "Register", "route": "route.registrations.store"}, {"label": "Cancel", "route": "route.registrations.destroy"}],
      "states": {"empty": "The meetup is full."}
    }
  ],
  "resources": [
    {
      "id": "resource.meetup",
      "change": {"kind": "alter"},
      "name": "MeetupResource",
      "model": "model.meetup",
      "fields": [
        {"name": "id", "type": "number"},
        {"name": "title", "type": "string"},
        {"name": "startsAt", "type": "string"},
        {"name": "capacity", "type": "number"},
        {"name": "seatsLeft", "type": "number"}
      ]
    }
  ],
  "policies": [
    {
      "id": "policy.registration",
      "change": {"kind": "add"},
      "name": "RegistrationPolicy",
      "model": "model.registration",
      "abilities": [{"name": "delete", "rule": "The signed-in user made the registration."}]
    }
  ],
  "tasks": [
    {
      "id": "task.registrations",
      "entity": "Registration",
      "summary": "Register until the meetup is full, cancel your own registration, and see the seats left.",
      "covers": [
        "model.meetup",
        "model.registration",
        "controller.registrations",
        "action.meetups.show",
        "route.registrations.store",
        "route.registrations.destroy",
        "view.meetups.show",
        "resource.meetup",
        "policy.registration"
      ],
      "acceptance": [
        {
          "id": "AC-registrations-1",
          "description": "A signed-in user can register for a meetup with seats left.",
          "kind": "success",
          "actor": "user",
          "route": "route.registrations.store",
          "given": ["a meetup with 2 seats exists"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-2",
          "description": "Registering for a full meetup writes no row.",
          "kind": "state",
          "actor": "user",
          "route": "route.registrations.store",
          "given": ["a meetup with 1 seat and 1 registration exists"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-3",
          "description": "Registering twice writes no second row.",
          "kind": "state",
          "actor": "user",
          "route": "route.registrations.store",
          "given": ["the user is registered for a meetup"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-4",
          "description": "A guest cannot register.",
          "kind": "unauthenticated",
          "actor": "guest",
          "route": "route.registrations.store",
          "given": ["a meetup exists"],
          "expect": {"redirect": "/login"}
        },
        {
          "id": "AC-registrations-5",
          "description": "A user cannot cancel someone else's registration.",
          "kind": "forbidden",
          "actor": "user",
          "route": "route.registrations.destroy",
          "given": ["another user's registration exists"],
          "expect": {"status": 403}
        },
        {
          "id": "AC-registrations-6",
          "description": "A guest cannot cancel a registration.",
          "kind": "unauthenticated",
          "actor": "guest",
          "route": "route.registrations.destroy",
          "given": ["a registration exists"],
          "expect": {"redirect": "/login"}
        },
        {
          "id": "AC-registrations-8",
          "description": "A user can cancel their own registration.",
          "kind": "success",
          "actor": "user",
          "route": "route.registrations.destroy",
          "given": ["the user is registered for a meetup"],
          "expect": {"status": 303}
        },
        {
          "id": "AC-registrations-7",
          "description": "The meetup page shows the seats left.",
          "kind": "success",
          "actor": "guest",
          "route": "route.meetups.show",
          "given": ["a meetup with 2 seats and 1 registration exists"],
          "expect": {"status": 200}
        }
      ]
    }
  ]
}
```

</details>

第 2 章と同じく、第 6 章と第 7 章の本文はこの参照用の計画の要素名を使って説明します。ここまでエージェントが書いた計画で進めてきた場合は、ここが 2 回目の切り替えどころです。上のブロックの内容で `docs/plans/registrations/plan.json` を上書きしてください。ただし、第 5 章の終わりの時点でアプリが参照用と一致していないと、この方法は使えません。1 本目をエージェントの計画で進めたなら、2 本目もそのまま進め、本文の名前は例として読み替えてください。

## 2. add、alter、existing

```bash run
bunx guren plan:render docs/plans/registrations/plan.json
```

`docs/plans/registrations/plan.html` を開いて **Changes only** をオンにすると、残った要素は次の 3 種類に分かれます。

| change | 要素 | 意味 |
|---|---|---|
| `add` | `Registration`、`RegistrationController`、ルート 2 つ、`RegistrationPolicy` | 1 本目の計画と同じく、新しく書くコード |
| `alter` | `Meetup`、`MeetupResource`、`meetups/Show`、`MeetupController.show` | すでにあり、これから変更するコード |
| `existing` | `User`、`meetups.show` のルート | 参照するだけで変更しない (**Changes only** では非表示) |

`alter` では、何が変わるかを、Guren がコードから読み取れるプロパティとして書きます。この計画では `Meetup` に `registrations` のリレーション、`MeetupResource` に `seatsLeft` のフィールド、`meetups/Show` に `registrationId` の prop が加わります。ループはあとでこのプロパティを読み、変更が実装されたかどうかを判断します。

## 3. Impact を読む

`alter` のカードにはすべて **Impact** の一覧があり、その要素に依存しているとスキャナが判断したコードが並びます。

![レビューページの MeetupResource のカード。alter の印があります。Impact の一覧には MeetupController の index、show、edit のアクション、それぞれのルートと ApiRoutes のエントリ、index と edit に届くテストのリクエスト、meetups/Edit、Index、Show のページが並びます。その下の計画されたフィールドは seatsLeft: number で終わります](../../images/agent-course-impact.png)

この一覧を見たら、**計画がそれぞれの項目に対応しているか** を確かめてください。今回は `MeetupResource` に `seatsLeft` が加わり、この Resource を `index`、`show`、`edit` の 3 つが使っています。3 つとも Resource に登録数を渡さないと、一覧ページと編集ページで `seatsLeft` が正しい値になりません。計画で変更するアクションは `show` だけなので、残りの 2 つには http ステップでエージェントが気づく必要があり、読者はそのコミットでその点を確認します。

手で Resource を組み立てるコードや生のクエリのように、スキャナから見えない依存はこの一覧に載りません。実際の依存は一覧より多いことがある、と考えてください。

| 確かめること | ページで見る場所 |
|---|---|
| 各 `alter` が、変更内容を説明文だけでなくプロパティでも書いている | 要素のカード |
| Impact の各項目が、計画で扱われているか、手を入れなくても問題ない | **Impact** |
| 破壊的変更の一覧に、想定外のものがない | Needs attention |
| 変更・削除するカラムについて、既存の行の扱い (`dataMigration`) が書かれている | カラムのカード |

この計画はカラムを変更しないので、データ移行は不要です。これに加えて、第 2 章のチェック表でも確認します。今回なら、`registrations.destroy` が Policy で守られていることと、登録した本人が取り消せることを示す `success` の振る舞いとして `AC-registrations-8` があることを確かめます。

## 4. 回答して承認する

質問には第 3 章と同じ手順で答えます。ページで **refuse** を選んで **Copy prompt for the agent** を押し、コピーした依頼文を Claude Code のセッションに貼り付けます。送る前に、その下へ次の文を書き足してください。

```text
満席の勉強会は登録を断ります。キャンセル待ちは後の変更で扱います。registrations.store の 2 つの警告は残してください。サインインしたユーザーなら誰でも登録でき、リクエストにボディもないからです。
```

**エージェントなしの場合:**

```bash run fallback
bunx guren plan:revise docs/plans/registrations/plan.json --ops - <<'EOF'
{
  "ops": [
    {"op": "remove", "id": "Q-full", "reason": "Answered: a full meetup refuses the registration."},
    {"op": "modify", "section": "plan", "element": {"title": "Registrations", "summary": "Signed-in users register for a meetup until it is full and cancel their own registration. The meetup page shows the seats left.", "scope": {"goals": ["Register for a meetup", "Cancel your own registration", "See the seats left"], "nonGoals": ["Paid tickets", "Registering someone else"]}, "assumptions": ["The organizer can register for their own meetup", "A full meetup refuses a registration; a waitlist is a later change"], "hints": [], "locale": "en"}, "reason": "Record the answer to Q-full."}
  ]
}
EOF
```

```bash run
git add docs/plans
git commit -m "docs: plan registrations"
bunx guren plan:approve docs/plans/registrations/plan.json
```

承認は通りますが、`action.meetups.show` について参考扱いの警告が 1 件出ます。計画ではこのアクションがページに渡す値を変えますが、Guren がアクションから読み取るプロパティは描画するページだけで、その点は変更前から計画どおりです。この変更はコードのプロパティには現れないため、`plan:status` がプロパティだけで確認することはできません。確認するには、このアクションに到達する振る舞いの検証が通る (`verified`) 必要があり、この計画では `AC-registrations-7` (「勉強会のページに空き席の数が出る」) がそれに当たります。

この警告を見たら、そうした振る舞いが計画にあるかを確かめてください。今回はあるので、そのまま承認します。もしなければ、誰かが `plan:waive` で免除するまで、この変更は確認されないまま残ります。

承認時には、各 `alter` がその時点でどう読み取れたかも `approvals.json` に記録されます (第 3 章の演習で見た `readings` です)。ループはこの記録を使って、「この計画で変わった」ものと「もともとそうなっていた」ものを区別します。

```bash run
git add docs/plans
git commit -m "docs: approve the registrations plan"
```

## ここまでの状態

- 参加登録を追加し、1 本目で書いた勉強会のコードを変更する 2 本目の計画ができ、承認も済んでいます。
- `alter` を見たら Impact を読み、依存している各コードに計画が対応しているかを確かめる習慣が身につきました。

## よくあるつまずき

- **`plan:render` が "only existing is consistent there" で失敗する。** `existing` にしたコントローラーの下に、`alter` のアクションを置いています。コントローラーも `alter` にしてください。
- **使われていると分かっている要素の Impact が空。** スキャナは、静的に解決できる import と名前しか追えません。一覧が空でもそのまま信じず、コードを検索して確かめてください。

## 演習

1. 計画のコピーから `AC-registrations-7` を削除してアプリの外に保存し、`--app .` と、出力先をアプリの外にした `-o` を付けて描画してください。どの要素で、どの検査が失敗しますか。
2. `docs/plans/registrations/approvals.json` を開き、`view.meetups.show` の `readings` を確認してください。`differ` (不一致) と読まれた prop と、`match` (一致) と読まれた prop はそれぞれどれですか。また、ループがあとでこの計画の成果として確認できるのはどちらですか。

## 次へ

[第 7 章: 実装中にアプリが変わったとき](./07-when-the-application-moves.md) では、同僚が並行してコードを変更する中で、この計画を実装します。
