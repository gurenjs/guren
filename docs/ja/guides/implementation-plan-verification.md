# 実装計画リファレンス: 承認と検証

このページには、承認と検証の判定の規則をまとめています。判定が意外だったときに参照してください。規則が使われる流れは[実装計画](./implementation-plans.md)に、用語はその[用語](./implementation-plans.md#用語)の表にあります。

## Impact

計画で変更・改名・削除する要素ごとに、アプリケーションの中でその要素に依存しているものが、`plan:render` の書き出すレビューページに一覧表示されます。一覧に載るのは、リレーション、ルートとその `ApiRoutes` のエントリとエージェントツール、Resource、Policy、コントローラーのアクション、テスト、カラムの場合はそのカラムを読み書きしている箇所です。

ブログの `posts.excerpt` を `summary` に改名する計画では、カラムの下に次の一覧が出ます。

```text
PostResource reads it                              app/Http/Resources/PostResource.ts:32
posts/Index reads it through PostResource          resources/js/pages/posts/Index.tsx:80
posts/Show reads it through PostResource           resources/js/pages/posts/Show.tsx:60
PostController.store writes data no static scan can name the columns of
PostController.update writes data no static scan can name the columns of
```

テストは 2 つの方法で探します。1 つは、`TestApp` のリクエスト (`get`、`post`、`put`、`patch`、`delete`、`query` とエージェントツールの呼び出し) をルートグラフと照合する方法で、各ルートの下にはそこに届くリクエストが並びます。もう 1 つはファイル名による方法で、コントローラーやモデルの名前が付いたテストファイルも「ファイル名で対応」として並びます。アクションを直接呼ぶテストからは、読み取れるリクエストがないためです。

例の計画を実装し終えたあとで、コメント削除のルートを移す計画を書くと、次のように表示されます。

```text
Route comments.destroy
ApiRoutes entry comments.destroy
Request DELETE /comments/${…} reaches comments.destroy    tests/comments.test.ts:38
```

ブログにもともとあるテストは HTTP を通さずにコントローラーを呼んでいます。そのため `posts.show` を移す計画では、ファイル名で見つかったテストだけが並び、リクエストは見つかりません。

```text
Route posts.show
ApiRoutes entry posts.show
Test tests/controllers/PostController.test.ts, named after it
No TestApp request in the existing tests reaches the routes above.
```

最後の注記は、見落としの可能性がないときにだけ表示されます。パスを読めないリクエスト (変数から組み立てたものや、`TestApp` だと判断できない受け手に対するもの)、ルートパラメータの制約を確かめられなかったリクエスト、解析できなかったテストファイルがあった場合は、この注記の代わりに、そのことが要素の横に書かれます。

Impact に出るのは影響の下限です。静的な走査なので、別の関数やファイルに渡った値、再代入、変数に入れたカラム名までは追えません。一覧が空でも、影響がないとは限らず、何も見つからなかったというだけです。

カラムの削除や形の変更、ルートの改名や削除、公開済みのエージェントツールの変更は、Impact の結果にかかわらず、互換性を壊す変更として表示されます。

## 承認の詳細

validator は、export されたスキーマのシンボル名で探します。`app/Http/Validators/` のファイルを import せずに読み、export されている名前を集めます。コントローラーの中のスキーマや、別の場所からの再 export は読めないので、どのファイルでも宣言・export されていない名前は、失敗ではなく警告になります。

セクションを読めなかった場合 (構文解析できないファイルや、`export *` で export しているファイルがある場合など) は承認が拒否され、ハッシュのないまま残る要素が示されます。`--allow-unstamped` を付けると、それらの要素を除いて承認します。

validator を読めるようになる前に承認した計画には、validator のハッシュがありません。その validator を書いたあとで再承認すると、その名前は衝突ではなく `plan:app-unjudged` の警告として報告されます。計画自身が書いたものかどうかを、基準点から判断できないためです。

編集した計画をもう一度承認すると、新しいハッシュが記録され、基準点はそのまま残ります。各ステップは新しいハッシュのもとで検証し直すことになります。

承認の前には検査と質問の確認がもう一度行われ、その時点のアプリケーションと突き合わされます。このとき、計画自身が行った作業は妨げになりません。計画どおりに実装し終えた要素は検査から差し引かれ、どれを差し引いたかが承認時に表示されます。

```text
Built as the plan leaves them, so their collision or absence is the plan's own work: model.comment, controller.comments, resource.comment, policy.comment, action.comments.store, action.comments.destroy
```

差し引かれるのは、アプリケーションが計画の想定する出発点から始まり、今は計画が目指す姿になっている要素だけです。それ以外はこれまでどおり拒否されます。たとえば、あとからの編集でアプリケーションがすでに持っていた名前に付け替えた `add`、計画で足すテーブルを別のアプリケーションルートがすでに宣言している場合、別のルートが使っているエンドポイント、クラスだけ書かれてテーブルがまだないモデル (出発点でも到達点でもない状態) がこれに当たります。パスも動かす `rename` や `alter` のルートは「作り終えた」とは判断されず、拒否する側に倒します。

下書きの扱いは変わりません。刻んだ記録がないので何も差し引かれず、`add` の要素がすでにあれば拒否されます。

この判定の精度は、鮮度の判定と同じ程度にとどまります。計画と同じアプリケーションルートに別のコミットが足した同名のクラスや、計画が作ったルートと同じエンドポイントに足された 2 本目のルートも、計画自身の作業として扱われます。また、`existing` を `drop` に変えた要素は、別の誰かが先に消していれば差し引かれます。刻んだ記録では存在していて、今は無くなっているためです。

## `alter` の読み取り

`alter` は計画より前からあるものを変えるので、承認の時点ですでに一致していた性質は、変更が済んだ証拠になりません。そこで承認のたびに、`alter` の要素ごとに計画が書いた性質をその場で読み、結果を `approvals.json` のその承認の項目に記録します。`plan:status` が `alter` の性質を完了と数えるのは、承認時に `differ` か `unknown` だったものが今は一致している場合だけです。

読み取り結果が実装前のアプリケーションを表すように、計画は実装を始める前に承認してください。編集した計画を承認し直した場合、同じ基準点のもとで記録した読み取りは引き継がれます。ただし引き継がれるのは、計画上の値とコード上の名前を編集で変えていない性質の読み取りだけです。

承認時の読み取りがない性質は、一致していても完了と数えません。実装の前であれば、`plan:status` はまだ食い違っているそうした性質を挙げ、直し方を示します。

```text
  planned   alter     Post                       model.post
      differs: relationship comments (planned hasMany, found not declared)
      differs: relationship comments target (planned Comment, found not declared)
      The approval recorded no reading of relationship comments, relationship comments target: run guren plan:approve on the plan before changing them, since a match with no reading from before the work does not count.
```

すでに承認済みのハッシュに対して `plan:approve` を実行すると、承認の項目に足りない読み取りだけが書き足されます。

```text
Already approved at 2026-09-22T10:16:20.673Z; recorded the readings it lacked in docs/plans/comments/approvals.json: model.post, view.posts.show.
```

実装のあとで読み取ると、性質はすでに一致しています。そのため、実装後に承認し直しても役に立ちません。

一致した性質のどれにも読み取りがない `alter` は `unjudged` になり、その要素に届く振る舞いで検証するよう注記が付きます。ステップの検証が通ったあとは、免除する (`plan:waive`) という選択肢を示す注記も加わります。カラムのように振る舞いが届かない要素には、免除だけが示されます。

読める性質がすべて承認時にすでに一致していた `alter` は、性質によっては完了になりません。`plan:approve` はそうした計画も承認しますが、要素と性質を挙げて警告します。`--json` では `heldAlters` に並びます。

警告は承認の項目に記録した読み取りから判定するので、同じハッシュを承認し直すと同じ警告が出ます。同じ基準点のもとで実装後に承認し直した場合、実装で変えた性質については警告しません。

次の例は、ページですでに宣言されている `post` prop を `view.posts.show` で書き直しただけの計画です。

```text
Warning, advisory (the approval stands):
  view.posts.show (posts/Show): every readable planned property already held at approval (prop post); none shows the change, so plan:status reports it unjudged. State the change in a property the application does not hold yet and approve the plan again, or expect that it completes only through a verified behaviour that reaches it, or by a waiver.
```

承認時に `unknown` だった性質は、一致していたとは数えません。警告はその性質を、まだ変更を示せる唯一の性質として挙げます。ただし変更を示せるのは、読み取れるようになってから一致した場合だけです。読める性質が 1 つもない `alter` には警告を出さず、前述のとおり `plan:status` が `unjudged` と報告します。

## 実装済みの計画の改訂

実装済みの計画を改訂すると、すべてのステップがもう一度やり直しの対象になります。古いハッシュでの記録は、新しいハッシュのもとでは数えられないためです。`plan:next` は、以前のハッシュで検証済みだったステップを再確認の対象として示します。ファイルがすでにある `scaffold` や `tests` のステップは、以前の版の計画で作られたものとして示されます。`plan:scaffold` は書き込み先が 1 つでもすでにあるステップを拒否するので、`plan:next` は `plan:verify --step` を案内し、まだないものを手で書く対象として一覧にします。`--step` を付けない `plan:verify` は、計画全体を一度に再確認します。

単純に再実行できないのは `tests` ステップだけです。コードができたあとは振る舞いのテストが通るのに、`tests:fail` はテストの失敗を求めるからです。そこで、このステップの検証が通った実行では、振る舞いごとに失敗を確認したことを記録しておきます。記録のキーは計画に書かれたテストの形で、description 以外のすべてのフィールドに、ルートのメソッドとパス、期待するページを加えたものです。

以降の実行では、改訂がテストに触れなかった振る舞いについてこの記録を引き継ぎ、改めて失敗を求めるのは変わった振る舞いだけです。その振る舞いは、古い計画で実装したコードに対して失敗させます。

この記録を持たない `tests` ステップ (この規則より古い CLI で検証したもの) は、振る舞いが通るようになると検証できず、Stop hook はすぐに打ち切ります。このステップは要素を持たないので、`plan:close` はこのステップを待ちません。

## `plan:verify` によるテストのリクエストの読み取り

`plan:verify` は、テストを実行する前に、各振る舞いのテストが振る舞いの指すルートへ `TestApp` でリクエストしているかを確認します。タイトルに id を含む `test`、`it`、`describe` のどれかが、そのメソッドとパスへリクエストするか、ルートのエージェントツールを呼んでいる必要があります。リクエストは本体に書くか、本体から呼ぶ同じファイル内の関数に書きます。`` `/comments/${id}` `` のようにセグメント全体を実行時の値で埋めたパスは、制約付きのパラメーターにも届くものとして数えます。

別のルートへリクエストしているテストや、何もリクエストしていないテストがあると、実際に何をリクエストしているかを示してコマンドが失敗し、`bun test` は実行されません。

この読み取りで解決できないリクエストがある場合も、別の理由でコマンドが失敗します。ファイルに書かれていないパス、import したヘルパーの戻り値に対するリクエスト、`TestApp` や `Promise<TestApp>` の注釈がない同じファイル内の関数の戻り値に対するリクエスト、別ファイルの関数に渡した `TestApp`、実行時に組み立てたタイトルがこれに当たります。こうした書き方に変えたテストでステップの検証が通ってしまわないよう、この判定は安全側に倒しています。指摘では、リクエストをテストに直接書くか、ヘルパーに注釈を付けるよう求められます。

この仕組みは改ざんを検出するためのもので、正しさを証明するものではありません。ファイルに書かれたリクエストは、実際に実行されるかどうかに関係なく通ります。

## ステップの結果の詳細

次の例は、モデルのリレーションがまだ型検査を通らない `data` ステップです。

```text
task/entity/model.comment/data: failed (1254 ms)
  pass     codegen     bun run codegen
  pass     db:migrate  bun run db:migrate
  fail     typecheck   bun run typecheck
      `bun run typecheck` exited 1
      app/Models/Post.ts(26,14): error TS2345: Argument of type '"comments"' is not assignable to parameter of type '"author"'.
```

同じステップでリレーションを書く前だと、結果は次のようになります。

```text
task/entity/model.comment/data: incomplete (1055 ms)
  pass     codegen     bun run codegen
  pass     db:migrate  bun run db:migrate
  pass     typecheck   bun run typecheck
  not at its completion state: model.post: planned
  not at its completion state: model.comment: drifted
```

TypeScript のコンパイラーにパスが通っていないマシンでは、次のようになります。

```text
task/entity/model.comment/scaffold: blocked (354 ms)
  pass     codegen     bun run codegen
  blocked  typecheck   bun run typecheck
      `bun run typecheck` exited 127: a tool it needs is not installed
```

`data` ステップでは、`db:migrate` を実行する前に、スキーマの変更がすべてマイグレーションに含まれているかをアプリケーション自身の drizzle-kit に確認します (`drizzle-kit generate --explain`)。これはマイグレーションを書き出さず、データベースも開かない試行です。この確認がないと、マイグレーションのないテーブルでもステップが通ってしまいます。`db:migrate` に適用するものがないためです。

次の例は、マイグレーションを入れ忘れた `data` ステップです。

```text
task/entity/model.comment/data: failed (1383 ms)
  pass     codegen     bun run codegen
  fail     db:migrate  drizzle-kit generate --explain
      the schema has changes no migration covers: generate one with `guren make:migration`
      create_table comments
      create_index comments
      create_index comments
      create_fk
      create_fk
  pass     typecheck   bun run typecheck
```

マイグレーションを生成し (`bunx guren make:migration --name create_comments_table`)、コミットしてから検証し直してください。この試行はスキーマ全体をマイグレーションのフォルダーと比べるので、計画に含まれないスキーマの変更があってもステップは失敗します。

## ステップごとのファイル数と行数

記録には、ステップの実装にかかった作業量も残り、出力では `work:` の行に表示されます。値は、`plan:next` がステップに印を付けたときの `HEAD` のコミットから数えた、触ったファイルの数と追加・削除した行の数です。コミット済みの変更も未コミットの変更も含みます。計画とその記録、`.guren/`、ロックファイル、drizzle-kit のスナップショットは数えませんが、マイグレーションの SQL は数えます。

数値はステップが初めて検証を通った実行で確定し、あとで確かめ直しても変わりません。`plan:next` が印を付けていないステップ (`--step` なしの `plan:verify` で実行したものなど) は、理由付きで `not measured` になります。開始コミットが rebase で履歴から外れた場合も同じです。

`plan:status --json` は、`verification.work` にステップ id ごとの数値を載せます。この数値によって拒否されたり待たされたりすることはなく、ステップ幅の既定値を見直すための材料として使います。

## 要素が完了と数えられる条件

どのスキャナーも読まない性質は、一致とは数えません。計画が書いた性質をどれも読めない要素は、完了ではなく `unjudged` になります。

例外は取り付け先を持つ種類の要素で、validator、アクション、ルート、ページ、副作用は、取り付けられていれば完了します。取り付けられているかどうかは、その要素自身を読んだ結果だからです。コントローラーのように性質を 1 つも書いていない要素は、存在するだけで完了します。

`alter` は取り付け先があっても、承認時の読み取りから変化したものしか数えません ([`alter` の読み取り](#alter-の読み取り)を参照してください)。

ルートは、マウントされていてもリクエストが届かないことがあります。同じメソッドか `ALL` で先に登録されたルートが、そのパスに合うリクエストをすべて受けてしまう場合です。たとえば `GET /comments/:id` のあとに登録した `GET /comments/new` には、リクエストが 1 件も届きません。

このようなルートは `present` にとどまり、このルートからしか届かないアクション、validator、ページも同じく `present` のままです。登録順やパスを比べられず、横取りされているかもしれないルートも `present` にとどまります。注記には、先に登録されたルートと、それを登録したルートファイルかモジュールが表示されます。計画のルートを先に登録するか、パスを変えてください。

副作用が取り付けられていると判定されるのは、テストとクラス自身のファイルを除くアプリケーションのソースが、フレームワークの API でそのクラスを使っている場合です。ジョブのディスパッチやスケジュール登録、イベントの発行、リスナーの登録、メールの送信やキューへの投入、通知の送信がこれに当たります。

その使用箇所が書かれるまで、ステップは `incomplete` です。書かれればステップは検証を通れるようになりますが、要素は `wired` のままです。どのアクションから使っているかを、計画の `trigger` と照らし合わせることはしません。

計画が書いた性質のうち、存在すること以外に一致したものがない要素は、ステップの検証が通っただけでは `verified` になりません（validator や Resource が宣言するキーと、Policy が宣言する ability は、名前があることしかわからないので、存在だけの一致として扱います）。こうした要素が `verified` になるのは、通った振る舞いが計画自身の参照をたどってその要素に**到達**しているときだけです。

- 振る舞いは、そのルートと期待するページに到達する
- ルートは、そのアクションとバインドしたモデルに到達する
- アクションは、その validator と Policy、返すページや Resource に到達する
- ページは、prop の Resource に到達する
- 到達した Resource や Policy からは元のモデルに、到達したアクションからはそのコントローラーに到達する

フォームの validator、フォームの送信先のルート、ページのボタンが呼ぶルートからは到達しません。あるルートへリクエストしても、そこへリンクしているページについては何もわからないからです。数えるのは、振る舞いが通ることを求めるステップの振る舞いだけで、失敗を確かめる `tests` ステップの振る舞いは数えません。

そのため、次の要素がある場合は、そこに到達する振る舞いを足すか免除を記録するまで、計画を閉じられません。キーや ability しか一致しなかった validator、Resource、Policy、計画が書いた prop がどれも一致しなかったページ、性質を 1 つも書いていないコントローラー、読み取りに照らして数えられる一致がない `alter` です。

カラム、コマンド、ジョブ、イベント、リスナー、メール、通知にはどの振る舞いも到達しないので、自身の性質で `verified` にならなければ、免除でしか閉じられません。`verified` にならなかった理由は、`--json` の `hold` に記録されます。

計画が書いた `body`、`params`、`query` の validator は、アクションがそれで検証しているか、ルートが契約スキーマとして持っていれば一致と数えます。別のスキーマで検証している場合、その場で組み立てたスキーマ (`this.validateBody(PostSchema.partial())` など) を使っている場合、ヘルパー経由で検証している場合は、アクションを `drifted` にはせず、注記付きの `present` にとどめます。

validator の `fields` は export された zod のスキーマから、Resource の `fields` は `guren codegen` が読むペイロードの型から、Policy の ability はメンバー名から読み取ります。キーや ability がない場合、フィールドの型や必須かどうかが計画と食い違う場合、値の範囲が計画より狭い場合は `differ` になり、`plan:verify` はそのステップを `incomplete` と報告します。

transform、refinement、union の奥にあるフィールドのように確実に判定できないものは、推測せずに `unknown` にします。その理由は `--json` の性質ごとに出力されます。部品ごとの規則は、[RFC 0030](https://github.com/gurenjs/guren/blob/main/rfcs/0030-implementation-plans.md) §6 の、フィールドの読み取りと Policy の ability についての追記にあります。

## 鮮度

承認済みの計画では、`plan:status` は参照している要素を、承認時のハッシュとも比べます。

```text
Against the approved baseline: fresh 14, stale 0, unstamped 0, unjudged 0
```

アプリケーションが承認時の形か、計画が目指す形を保っている間は、その要素は `fresh` です (どちらなのかは `--json` の `basis` に出ます)。ほかの変更で別の形に変わると `stale` になります。

`unstamped` はハッシュがない要素で、承認時にセクションを読めなかったもの、改訂であとから加わったもの、validator を読めるようになる前に承認した計画の validator が該当します。`unjudged` は、今は読めない要素です。どちらも、要約行の下に id が並びます。参照している要素に触れないコミットであれば、計画は `fresh` のままです。

`stale` になった要素があると、その要素に依存するステップはすべて保留になります。次の出力は、例のコピーで、実装を始める前に別のコミットが `comments.store` というルートを登録したときのものです。

```text
Held, since what they depend on changed after the plan was approved:
  task/entity/model.comment/http
    route.comments.store (routes, add), owned by the step; named by AC-comments-1, AC-comments-2, AC-comments-3: What the scanners read for it changed since approval, to neither what was stamped nor what the plan leaves.
      fail  The route name "comments.store" already exists in this application.
```

`plan:next` は、その要素に依存しない次のステップを返し、終了コード 0 で終わります。出力の最後には、保留を解く 2 つの方法が示されます。

```text
A held step is a person’s decision: undo the change that moved it, or edit the plan so each stale element states what the application holds now (an `existing` action another commit renamed or removed names the one that stands in its place) and approve the edit:
  bunx guren plan:approve docs/plans/comments/plan.json
  Approval keeps the baseline the plan was first stamped with. Commit the edited plan and its approvals file before the next plan:next, which refuses them uncommitted.
```

鮮度は、編集した計画が目指す形と比べて判定されます。そのため、編集した計画を承認すれば、`stale` の要素は `fresh` に戻ります。

## 計画をまとめて見る: `guren check --plan`

```bash
bunx guren check --plan
```

`check --plan` は、開いている計画をまとめて調べます。対象は、アプリケーションのルートにある `*.plan.json` と、`docs/plans/` の下の `plan.json` と `*.plan.json` です。開いている計画とは、現在のハッシュで承認されていて、まだ閉じていない計画のことです。

報告されるのは、`drifted` の要素を持つ計画、[コマンドの検査](./implementation-plan-format.md#コマンド)で拒否されるコマンドを含む計画 (その検査ができる前に承認されたもの)、同じ要素を変更する 2 つの計画です。同じ要素かどうかは、id ではなく、アプリケーションの中で何を変えるかで判断します。

次の出力は、例の計画の途中で、`posts.excerpt` を改名する 2 つ目の計画を承認したときのものです。

```text
 WARN  [warn] Approved plan drifted: docs/plans/comments/plan.json has 2 drifted element(s): model.comment, resource.comment.

ℹ        → Run guren plan:status docs/plans/comments/plan.json for what differs, then fix the code or revise the plan.

 WARN  [warn] Open plans overlap: docs/plans/comments/plan.json and docs/plans/post-summary/plan.json are both approved and open, and both change: model class Post (model.post / model.post).

ℹ        → Land or close one plan before implementing the other, or revise one so they stop changing the same element.
```

2 つの計画ファイルが同じ slug を持つ場合 (状態ファイルと `docs/plans/<slug>.md` を共有してしまうため) と、計画ファイルや計画のディレクトリを読めない場合にも警告します。結果はすべて警告で、終了コードは 0 です。

計画の検査は `--plan` を付けたときだけ実行されます。`db/schema.ts` と validator のファイルを import するので、フラグなしの `guren check`、`check --ci`、`guren gate` には含まれません。

隣に承認の記録がある下書き (基準点を消した計画) と、読めない承認ファイルも報告されます。それ以外の下書きと、承認後に編集した計画は、まだ誰も合意していないので対象外です。
