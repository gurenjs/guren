# 変更のレビュー

`bunx guren add review` を実行すると、人が読む前にプルリクエストを判定する GitHub のワークフローが入ります。変更ごとに、レビューで気にすべき事実(マイグレーション、Policy の確認が外れたルート、新しく出た依存の脆弱性情報など)と、その事実が決めるレビューのレーンの下限(`low`、`medium`、`high`)を記録します。ワークフローが実行するのは 4 つの `change:*` コマンドで、どれも手元で実行できます。

| コマンド | 役割 |
|----------|------|
| [`change:lane`](#changelane) | 2 つのコミットの間の変更を読み、事実とレーンを出力する |
| [`change:evidence`](#changeevidence) | CI が実行するコマンド。gate とレーンの判定をまとめ、ジョブの要約用のファイルに書き出す |
| [`change:records`](#changerecords) | `change:lane` が比べる、ルートごとのセキュリティ記録を出力する |
| [`change:policy`](#changepolicy) | `REVIEW.md` の生成ブロックを作り直す |
| [`make:lesson`](#教訓) | レビューする人とエージェントが読む教訓を記録する |

## ワークフローを導入する

```bash
bunx guren add review
```

`add review` は Change ワークフローを入れます。このワークフローは、すべてのプルリクエストと `main` への push で `bunx guren change:evidence` を実行します。GitHub はリポジトリの直下にあるワークフローしか読まないので、対象はリポジトリの直下にあるアプリケーションで、その下の階層にあるアプリケーションでは実行を断ります。書き出すファイルは 6 つで(ハーネスに Cursor が入っているアプリでは `APPROVAL_POLICY.md` と `.cursor/BUGBOT.md` を加えた 8 つ)、どれも 1 回だけ書き、すでにあるファイルは `--force` を付けない限り再実行しても変えません。`--force` を付けても `REVIEW.md` だけは置き換えません。

- `guren.review.ts`(レビューのポリシー。後述)。
- `REVIEW.md`。Claude Code Review が読むファイルで、レビューする人に向けたルールと、`bunx guren change:policy` がアプリケーションから生成するブロックが入ります。ブロックに並ぶのは、`change:lane` が常に `high` にするもの、機密の列を持つモデル、データを変えるルートと通るミドルウェアやアクションが名前を出す Policy(Policy が実際に確認されている保証ではなく、どこを読むかの手がかりです)、エージェントが呼べるルートと公開先です。一度できたら、書き換わるのは `change:policy` が生成するブロックだけです。アプリケーションを読み込めないときは書きません。何も読めていないブロックが、最新の内容のように見えてしまうためです。
- `.github/workflows/change.yml` は、プルリクエストの head のコミット(GitHub のマージコミットではない)を履歴ごとチェックアウトし、どのブランチにも残っていない base(force push の後など)も取得して証拠を集めます。プルリクエストの base を付け替えたときも実行し直します。マージベースの記録は、既定のブランチへの push で走った実行が保存したものだけを `actions: read` の権限でダウンロードし、`--base-record` に渡します。プルリクエストはこの記録を書けないからです。そのうえで `evidence.md` をジョブの要約に足し、`record.json` を `guren-record-<head の SHA>` としてアップロードします。ジョブが失敗するのは gate が失敗したときだけです。失敗したときも要約と記録は残り、アップロードの失敗でジョブは失敗しません。ランナーから npm のレジストリに届かないときは、証拠のステップに `--no-deps` を足します。
- `.github/pull_request_template.md` は、issue と計画を求め、プルリクエストに表示される文で、レビューする人に `lane:` ラベルを 1 つ付けてもらいます。付けるのは、レビューする人自身が必要だと考えたレビューの重さで、ワークフローが出した下限とは別に選びます。`gh pr create --body` で作ったプルリクエストはテンプレートを使わないので、ジョブの要約にも同じ依頼を出します。
- `.github/ISSUE_TEMPLATE/feature.md` と `defect.md`。
- エージェントのハーネスに Cursor が入っているアプリ(`bunx guren agent:init --target cursor`)では `APPROVAL_POLICY.md` も書きます。Cursor の PR Routing & Approval が読むファイルで、Change の証拠が `eligible for low` のプルリクエストだけを承認するように指示します。このとき `change:policy` は `.cursor/BUGBOT.md` も保ちます。Bugbot がレビューのたびに読み込むファイルで、中身は REVIEW.md と同じブロックです。書いたルールも含めたファイル全体が Bugbot の読む 30,000 文字を超えるときは、常に人が読むものだけに絞ります。それでも超えるときはどちらのファイルも書かずに止まります。

ラベルは先に作っておかないと選べないので、コマンドは `gh label create` の 3 行を出力します。Change ワークフローは scaffold の `ci.yml` と同じ gate を実行します。`ci.yml` に `bunx guren gate` のステップが残っているときはそのことを知らせるので、Change ワークフローがプルリクエストで通ったら、そのステップは消してかまいません。

## `REVIEW.md` を最新に保つ

ルート、Policy、モデル、教訓、`guren.review.ts` を変えたら `bunx guren change:policy` を実行します。`--check` を付けると何も書かず、ブロックが古いときは終了コード 1 で終わります。アプリケーションを読み込めないときは、どちらも書かずに終了コード 1 で終わります。

ブロックの内容は、アプリケーションを env ファイル(`.env` など、Bun が読み込み、git に入れないファイル)なしで登録した結果なので、手元でも CI でも同じになります。アプリケーションのディレクトリと、コマンドを実行したディレクトリにある env ファイルが設定する値は、どの `NODE_ENV` のものでも外します。シェルが別の値で export した変数はそのまま効きます。ただし、env ファイルが別の変数を展開して作る値(`${PORT}` など)は、展開した結果にかかわらず外します。

`change:evidence` も `REVIEW.md` があれば同じ確認を行い、ブロックが古いとき(`review-doc-stale`)と、確認のためにアプリケーションを読み込めないとき(`review-doc-unchecked`)は変更を保留にします。workflow は失敗させません。`change:lane` は、生成されたブロックも含めて `REVIEW.md` の編集をすべて `high` にします(`BUGBOT.md`、`APPROVAL_POLICY.md`、`.cursor/approval-policies/` も同じです)。レビューする人はファイル全体を読み、変更の中でブロックをアプリケーションと照らし合わせるものがないためです。

## レビューのポリシー

`guren.review.ts` を置くと、`change:lane` と `change:evidence` が変更に付けるレーンを調整できます。

```ts manual
import { defineReviewPolicy } from '@guren/cli/review'

export default defineReviewPolicy({
  approvals: { low: 0, medium: 1, high: 2 },
  paths: { high: ['app/Billing/**', 'config/session.ts'], medium: 'config/**' },
  facts: { 'agent-tool': 'high', 'schema-changed': 'low' },
  identities: 'auto',
  merge: { low: 'person' },
})
```

- `paths` は、一致するパスに触れた変更の下限を決めます。パスはアプリケーションのルートからの相対で、`*` は 1 階層の中、`**` は何階層でも一致し、どちらも含まない glob は CODEOWNERS と同じくファイルかディレクトリを指します。それ以外の書き方(空の区切り、`.` や `..` の区切り、波かっこ、角かっこ、`?`、`@(a|b)` のような extglob)は、何にも一致しないまま受け入れるのではなく、ポリシーを読めないものとして扱います。一致した glob ごとに `review-path` の事実が 1 つ付きます。
- `facts` は事実ごとのレーンを決めます。上げるのはどの事実でもできます。下げられるのは計画で宣言できる事実だけで、宣言したときと同じところまでです。`schema-changed`、`migration`、`file-added`(ソースファイルの追加と、計画による追加として読んだ編集。後者には `source-edited` に設定した引き上げも効く)、`policy-added`、`file-removed`(計画が宣言した削除。`source-removed` に設定した引き上げも効く)、ルートの事実(`route-added`、`route-changed`、`route-removed`、`agent-tool`)、アプリケーションのエントリの配列の事実(`provider-added`、`config-added`)、`env-added` は `low` まで、`policy-changed` と `dependencies-changed` は `medium` までしか下げられません。常に high の事実(gate の入力、破壊的なマイグレーション、受け入れテストの編集、audit の失敗など)、それ以外の既存のソースの編集、ソースでないファイルの追加、スキーマのテーブルの中の関数とテーブル以外のコードの変更は下げられません。ポリシーで変えた事実には、レポートで `lowered by guren.review.ts` か `raised by guren.review.ts` と表示されます。
- `approvals`、`review`、`identities`、`merge` は、レーンごとの承認とマージの仕方を書く項目です。まだ強制はしません。`evidence.md` には、下限のレーンで必要になる承認の数が出ます。

適用するのはマージベースにあるポリシーです。`guren.review.ts` を編集するプルリクエストは編集前のポリシーで判定され、編集した内容はマージした後から効きます(gate の入力なので、その変更自体は `high` です)。このファイルは実行せずにデータとして読むので、値はすべてその場に書きます。変数、スプレッド、関数の呼び出し、知らないキー、許されていない引き下げが 1 つでもあると、ファイル全体を読めないものとして扱います。読めないポリシーは一切適用されず、変更は `high` に保留され、理由が「Not judged」に出ます。ポリシーが上げているレーンを見落とさないためです。

## `change:lane`

```bash
bunx guren change:lane --base 9f2c1ab --head 4e7d0c3
```

`change:lane` は、2 つのコミットの間の変更から事実を読み取り、レビューのレーンの下限(`low`、`medium`、`high`)を出力します。作業ツリーは読まず、git のオブジェクトから gate の入力、計画の記録、マイグレーション、スキーマのテーブル、受け入れテスト、Policy、依存を読みます。`--base` と `--head` にはコミットの SHA を渡し、両者のマージベースから先を変更として扱います。レーンが何であっても終了コードは 0 で、`--json` を付けるとバージョン付きのレポートを出力します。

### 変更の両側の audit

変更の両側で audit も実行し、base に無かったものを報告します。対象は、audit の失敗、レスポンスに出る機密の列、CSRF の免除、無効にされたセキュリティの既定値、変更が編集したモデルで新しく出たか、新しい列を挙げるモデルの規則の警告(`mass-assignment`、`owner-fillable`、`hidden-columns`)、抑制された指摘です。そのために各コミットを一時ディレクトリに展開し、手元の install を使って `guren audit` を走らせるので、コマンドを実行したシェルの環境変数のもとでアプリケーションのコードが読み込まれます。

コミットの lockfile がインストール済みのものと違うとき、何もインストールされていないとき、リポジトリ内のパッケージがインストールされているとき(ワークスペースのメンバー、`link:` や `file:` の依存)、コミットがアプリケーション内に symlink を持つときは audit を行いません。`--no-audit` でこの手順を省けます。

### 計画が宣言する事実

承認済みの計画が宣言している事実は、宣言どおりのレーンになります。計画が今のハッシュで承認されていて閉じておらず、変更が計画の記録を書いていなければ、次のものが `low` になり、事実の横に計画と要素が表示されます(`declared by docs/plans/comments/plan.json#model.comment`)。

- **ファイル。** 計画が追加する要素のために `plan:scaffold` が書くソースファイルの追加で、そのパスにあり、scaffold 自身の出力と同じ名前を export しているもの。Policy の Provider は scaffold が書くものと同じでなければならず、Policy とコントローラのファイルは import、型、クラスだけを持ち、クラスは scaffold が import する基底クラスを継承し、計画した ability やアクション以外のメンバーを持たないことが条件です。
- **テーブル。** 計画が追加するモデルのテーブルの追加で、列、デフォルト値、キー、インデックスを含めて、scaffold がそのスキーマに書くとおりに宣言されているもの。この場合、テーブルの中にあってスキーマの読み取りが追わないコード(`sql` のデフォルト値、インデックスのコールバック)も scaffold が書いたものとして扱い、それだけで `db/schema.ts` が `medium` になることはありません。テーブルを並べたオブジェクトにそのテーブルを足しても同じですが、そこからテーブルを外すと `medium` になります。
- **マイグレーション。** 追加したマイグレーションも、計画が追加するテーブルを drizzle-kit が書く形の文で作るだけなら `low` になります。ファイル全体としても、drizzle の migrator が `--> statement-breakpoint` で切り分けたときの各部分としても読みます。条件は、各 `CREATE TABLE` が計画どおりの列だけを持ち、各列の型、NULL の可否、キー、デフォルト値も scaffold の builder が書くとおりであることです。計画した一意制約、インデックス、外部キー(削除時の動作を含む)はそれぞれのテーブルの後にちょうど 1 回ずつ書かれ、それ以外は書かれていないことも求めます。さらに、フォルダには `migration.sql` と `snapshot.json` があってそれ以外はなく、snapshot が前のマイグレーションの snapshot に SQL が作るものを足しただけになっていなければなりません。

### ルートの事実

両側のセキュリティ記録を比べられたとき(後述)は、ルートの変化も事実になります。head が登録していて base に対応するルートがないものは `route-added`、どの head のルートとも対応しない base のルートは `route-removed`、対応したルートで記録のどこかが変わったものは `route-changed`、`.agent()` が付いた、変わった、外れたルートは `agent-tool` で、どれも `medium` になります。

追加したルートは、計画がプロジェクトのルートに同じメソッド、パス、名前で追加していて、記録が計画どおりなら `low` になります。記録が計画どおりとは、アクションが scaffold の書くコントローラのファイルが export する計画どおりのもので、middleware が名前で計画どおり(`auth` はユーザーを必須にするもの)であり、バインディング(モデルのファイルと export で比べる)と agent のメタデータも計画どおりで、各契約が計画したモデルの validator ファイルにある計画どおりの export で、描画したスキーマのキー、型、必須の指定、ルールが `plan:status` の判定で計画どおりであり、計画した Policy の ability をその Policy のモデルについて `authorize()` に渡していて(アクションへのルートがどれも 1 件のレコードをバインドするなら `[Model, record]`、そうでなければそれかクラスそのもの)、その呼び出しがアクション本体の文として await されていて、コントローラがそのモデルを同じ名前のままモデルのファイルから import し、ほかでその名前を束縛していないことです。

- 登録済みの別のルートと同じ名前を持つルートは宣言しません。
- `--mount` は scaffold のルートを先に登録するので、後に登録された、この変更が追加したのではない同じメソッドか `ALL` のルートに、同じリクエストが当たりうるパスがあれば宣言しません。
- バインディングは検索列まで読むので、計画した `key` はその列と照合し、計画にない列の指定はルートの変更として出ます。古い `@guren/core` では列が読めないので、バインディングは宣言しません。
- scaffold が書くルートファイルは、head のモデルと validator のファイルを前提に scaffold が書くとおりなら `low` になります。ルートのエントリの編集は、`plan:scaffold --mount` が書くとおりで、マウントしたファイルが scaffold の書いたままであり、変更のルートの事実がすべてそのファイルのルートの宣言済みの追加で、それぞれ 1 回ずつであれば、それだけで変更を `medium` にすることはありません。ただし、マウントしたファイルが設定する alias を別のルートが直接またはグループ経由で使っていて、エントリの registrar の最上位の文が呼び出しの後でその router に同じ alias を設定していないときは、編集を残します。
- `authorize()` の呼び出しは、アクションの本体の文として await され、その前に return しうる文がないものに限ります。エントリは書かれたとおりに読むので、実行されないエントリの文も同じように読めます。宣言したルートがあるときは、レポートにそのことを書き添えます。

別の開いている計画も同じファイルやテーブルを対象にしているときは、レーンを変えません。

### アプリケーションのエントリ、環境変数、コマンド

- アプリケーションのエントリ(`src/app.ts`、なければ `app.ts`)の編集が、`createApp()`(`@guren/core` から import してモジュールの最上位で呼ぶもの)のオブジェクトの `providers` と `config` の配列に名前を足し、それを束縛する import を足すだけなら、足した項目ごとに `provider-added` か `config-added` の事実になり、どれも `medium` になります。ファイルのほかの部分も変わっていれば `source-edited` のままです。オブジェクトにスプレッド、計算されたキー、`__proto__`、配列と同じ名前のメソッドやアクセサがあるときと、足した import がファイルのほかの箇所で読んでいる名前を束縛するときも `source-edited` のままです。
- Provider は、エントリが `plan:scaffold` が 1 つの scaffold ステップの Provider について書くとおりで、Provider とそれが登録する Policy が計画どおり(Provider はファイル全体、Policy は計画した ability)なら `low` になります。宣言したファイルの隣に拡張子だけ違うファイル(`P.ts` に対する `P.js` など。Bun はこちらを実行する)があるときは、宣言どおりとは扱いません。
- 開いている計画の `providers` や `config` の要素が足す項目は、それが要素のファイル(`app/Providers/<className>`、`config/<name>`)の default import で、足す計画が 1 つだけなら `low` になります([Provider と config](./implementation-plan-format.md#provider-と-config))。
- `config/env.ts` の `defineEnv()` に足したキーは `env-added`(`medium`)で、開いている計画の `env` の要素がそれを足していて、宣言が要素の書いたとおりなら `low` になります([環境変数](./implementation-plan-format.md#環境変数))。
- 開いている計画の `make:*` コマンドが書いた追加ファイルは、ジェネレーターが書いたままなら `low` になります。そのクラスを、コマンドと同じモジュールで計画が追加する要素が受け持つなら、その要素の検査を通れば `low` になります。Provider とルートファイルは、いつもジェネレーターが書いたままであることを求めます([コマンド](./implementation-plan-format.md#コマンド))。

### `medium` のまま残るもの

開いた計画の `alter` や `drop` のルートが述べる範囲を超えたルートの変更と削除、それ以外のことをするマイグレーション、既存のテーブルの変更、開いた計画の `drop` 要素が受け持たないファイルの削除、ブループリントや複数のファイルを書くジェネレーターが書いたもの、Policy の編集は、今のところ `medium` のままです。同じ計画の前のタスクが追加したモデルとコントローラーのファイルの編集は、計画の承認の記録を足したコミットにそのファイルが無く、すべてのルートのセキュリティ記録を比べられたときに、その計画による追加として読みます。

マージベースに `guren.review.ts` があれば、[レビューのポリシー](#レビューのポリシー)に従って事実のレーンを上げ下げします。

### 依存の脆弱性情報

依存に触れた変更では、変わったファイルごとにそれを管理する `bun.lock` を探し、両側で `bun audit` も実行します。インストールはせず、問い合わせるレジストリは base の `.npmrc` が指すものにし(環境変数によるレジストリの上書きは外す)、両側とも今日時点の脆弱性情報で比べます。head にあって base に無い脆弱性情報は `dependency-advisory` として常に `high` で報告します。`--no-deps` でこの手順を省けます。

`bun.lock` が変わっていないマニフェストの変更、バイナリの `bun.lockb`、依存があるのに `bun.lock` が無い base、`bun audit` が警告を出したスキャン(問い合わせを飛ばしたレジストリがある)は判定できないものとして並べます。`.npmrc` は、インストール先のレジストリを決めるので、どこにあっても gate の入力として扱います。

### セキュリティ記録

同じ 2 つの展開先でルートごとのセキュリティ記録(`guren change:records`)も読み、base と head をルートごとに比べます。ルートはコントローラのアクションで、見つからなければメソッドとパスで対応させます。

- middleware の鎖からガードが外れたとき、アクションから `authorize()`/`can()` や `auth.userOrFail()` の呼び出しが消えたとき、`authorize()` がアクションのたびには実行されなくなったとき(条件の下、return しうる文の後、`try` の中、`void` や `.catch()` の後ろ、ヘルパーの中に移ったとき)は `authorization-removed` になります。もとからそうでなかった呼び出しは、後の文が呼び出しや拒否の扱いを決めることがあるので、アクション全体で比べます。契約のスキーマや validate の呼び出しが消えたときは `validation-removed` になり、どちらも常に `high` です。
- base と比べて強弱を決められない記録(鎖の順番の入れ替え、capability を持たない middleware の削除、別の ability や対象(対象のクラスは import と再 export をたどって宣言しているファイルまで読むので、別のファイルの同名クラスは別の対象になる)、別の validator への差し替え、キーや制約が減ったスキーマ、アクションが validate に使うスキーマの宣言の変更、読めなかったアクション)は判定できないものとして `high` で並べます。変更のせいで head が読めなくなった場合も `high` になります。ガードや制約が増えただけの記録は事実になりません。
- 名前を決められない呼び出し(実行時に組み立てる ability、手で問い合わせる gate、その場で書いたスキーマ)は、アクションの本文とその引数から辿れる宣言のダイジェストで比べるので、そのソースが変わったときだけ強弱を決められない扱いになります。引数がアクション内のローカル変数のときは本文が参照するもの全部に、継承したアクションは `extends` で辿れるクラス文に広げて比べます。そのため、ガードが変わっていなくても、それらが変われば強弱を決められない扱いになることがあります。継承したアクションが別のファイルで参照するスキーマや ability は辿りません。`./` と `@/` 以外の別名を通した import は、指定子の文字列だけで比べます。インラインのルートハンドラの中身は読みません。

この install から base を組み直せないときは、`--base-record <file>` に、以前の `change:evidence` がマージベースについて書いた `record.json` を渡せます。その記録と、head だけを読んだ記録とを比べます。別のコミット、別の形式、別のデプロイ先、別の `NODE_ENV` の記録は比べずに判定しなかったものとして並べ、比べられる記録を書くにはどの実行をやり直せばよいかも示します。別のバージョンの `@guren/cli` やフレームワークが書いた記録は比べたうえで、そのバージョンを結果に添えます。

### 判定しないもの

読まないもの(この install から base を組み直せず、保存された記録もないときの記録、スキャンできなかった脆弱性情報、audit できなかった側)は「Not judged」に並び、下限は `medium` 以上になります。

## `change:evidence`

```bash
bunx guren change:evidence --base 9f2c1ab --head 4e7d0c3
```

`change:evidence` は、CI で gate の代わりに実行するコマンドです。`guren gate --deps` を実行し、`change:lane` と同じ判定をしたうえで、`evidence.json`、要約した `record.json`、ジョブの要約用の `evidence.md` をアプリケーションの `.guren/evidence/`(または、コマンドを実行した場所から見た `-o <dir>`)に書き出します。失敗するのは gate が失敗したときだけで、書き出せなかったファイルは標準エラーに出すだけで終了コードを変えません。

証拠から確かめられなかったことは保留として記録します。

- 失敗した gate
- `--head` にない、gate の実行中に移動した、または追跡中のファイルに未コミットの変更があるチェックアウト
- gate の codegen が書き換えたコミット済みのファイル
- 読めなかった変更(浅いクローン)と、コミットを含まない変更(base より古い head)
- このバージョンでは、閉じていない計画がひとつでもあるときの計画の証拠と、ページ、ルートファイル、翻訳カタログを変える変更のブラウザの証拠
- `REVIEW.md` があるときは、`change:policy --check` でブロックが古いと分かった場合と、その確認のためにアプリケーションを読み込めなかった場合

下限が low で保留がなければ low の対象になります。失敗したコマンドが出力した認証情報(URL のユーザー情報、秘密を表す名前の `NAME=value`)は、どのファイルでも伏せ字にします。

`--routes` は gate に、`--base-record` は `change:lane` に渡し、`--no-deps` と `--no-audit` で依存の走査(gate のものと両側の脆弱性情報)と両側の audit を省けます。audit を省かなければ、変更がどこに触れていても `record.json` に head のセキュリティ記録が入り、後の変更はこれを基準の記録として読みます。`guren add review` が書くワークフローは、既定のブランチへの push で走った実行がマージベースについて保存した記録だけを取ってきて渡すので、別のブランチに積んだプルリクエストには読める記録がありません。

## `change:records`

```bash
bunx guren change:records --json
```

`change:records` は、`change:lane` が比べる、ルートごとのセキュリティ記録を出力します。中身は、鎖に載っている middleware とそれぞれが宣言する capability(認証、認可)、契約のスキーマとその元になった validator の export、バインディングと `.agent()` のメタデータ、アクションの `authorize()`・`can()`・`auth.userOrFail()`・validate の呼び出しです。

env ファイルを読まずにアプリケーションを introspect するので、アプリケーションのコードが動きます。provider が例外を投げたときは何も読みません。introspect が飛ばした処理(`createApp({ boot })` のコールバックや provider の `introspect()` フック)は記録と一緒に並べ、`change:lane` は両側に並ぶルートを比べたうえで、それを `medium` として報告します。`--json` でバージョン付きの形を出力し、アプリケーションを読めなければ終了コード 1 で終わります。

## `change:policy`

```bash
bunx guren change:policy --check
```

`change:policy` は、`REVIEW.md` のうち、レビューで必ず読むものを並べたブロックを、登録されたアプリケーションから作り直します(`browser:map` と同じくアプリを introspect します)。`REVIEW.md` が無ければ作ります。

`paths` を持ちエンティティを持たない stable な教訓もここに載せ、入っているエージェントごとに `lessons` というルール(`.claude/rules/lessons.md`、`.agents/rules/lessons.md`、`.cursor/rules/lessons.mdc`、`.github/instructions/lessons.instructions.md`)に書き出します。ルールの対象は教訓の glob に絞ります。glob はアプリケーションのルートからの相対で、モジュールの教訓も同じです。Cursor と Copilot は一覧をカンマでつなぐので、`{a,b}` の波かっこは展開して書きます。該当する教訓がなくなったら消します。同じ名前で自分が書いたものではないファイルがあれば止まり、書く教訓がないあいだはそのまま残します。

`guren:review` のマーカーの外は書いた人のものなので残し、安全に書き換えられないマーカーがあれば何も書かずに止まります。`--check` を付けると何も書かず、保つファイルのどれかが無いか古いときは終了コード 1 で終わります。

## 教訓

```bash
bunx guren make:lesson "Load a comment through its post" --entity Comment --from 412
```

`make:lesson` は、教訓を採番付きファイルとして `docs/lessons/` に記録します。frontmatter にはルールを 1 行だけ書きます(`rule:`。`--rule` を省くとタイトルを使います)。最初は `status: draft` で、まだ誰にも届きません。人が `stable` にしてマージすると、`guren context <Entity>` が、名前の挙がったエンティティごとに Lessons の見出しの下にルールを出します。

- `--entity` で `entities:` を、`--paths` でエンティティを持たない教訓が対象にする glob を埋め、`--from <commit|pr>` で出どころを記録します(`source:`。種類は `--kind` で `review-finding`、`escaped-defect`、`revert`、`stall`、`waiver`、`declined-finding` から選びます)。
- チェックで捕まえられるようになったら、`--enforced-by <file>#<name>` でそのチェックを書きます(手で `enforcedBy:` を足してもかまいません)。
- `--from <commit>` に不具合を取り除いたコミットを渡すと、そのコミットと親でテストを実行して `reproduced` を記録します。`[<name>]` を題に含むテストが親で失敗し、そのコミットで通れば `true`、親で通れば `false`、それ以外は `not-run` になり、理由は `reproducedBecause` に残ります(`--no-reproduce` で実行を省きます)。テストは今の環境変数のまま動きます。

`guren check --docs` は、160 文字を超えるルールと、ファイルに書かれていない `enforcedBy` を失敗にし、`review:` の日付を過ぎた教訓には警告を出します。

## 次のステップ

- [CLI リファレンス](./cli.md): ほかのコマンドの一覧
- [実装計画](./implementation-plans.md): 事実のレーンを下げる宣言のもとになる計画
- [チェックと監査の詳細](./cli-checks.md): `change:lane` が両側で実行する audit の中身
