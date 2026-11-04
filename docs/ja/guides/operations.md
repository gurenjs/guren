# 本番運用ランブック

GA（正式リリース）までに整えておきたい、最低限の運用基準をまとめます。

## SLO 基準

- API 可用性: **月間 99.9%**
- 主要ルートの p95 レイテンシ目標: **300ms 未満**
- エラーバジェットを使い切ったら、機能開発より信頼性の改善を優先する

## 最低限の監視

- `/health` をロードバランサーのヘルスチェックにつなぐ
- stdout/stderr のログを 1 か所に集める
- 次のアラートを設定する
  - 5xx 率が上がったまま下がらない
  - ヘルスチェックが失敗する
  - キューのバックログが増え続ける
  - DB に接続できない

## バックアップ方針

- PostgreSQL を毎日自動でバックアップする
- 保持期間の例: 日次 7 世代、週次 4 世代、月次 3 世代
- 保存時と転送時に暗号化する
- 四半期ごとにリストア訓練を行い、記録を残す（必須）

## インシデント対応

- 重大度: SEV-1/SEV-2/SEV-3
- SEV-1 では次のように動く
  - インシデントコマンダーを決める
  - 30 分ごとに状況を共有する
  - まず被害を抑え、そのあとで根本原因を分析する（RCA）
- SEV-1 はすべてポストモーテムを公開する

## デプロイ安全チェック

本番にデプロイする前に、次のコマンドを実行します。

```bash
bun run build
bun run typecheck
bun run test
```

デプロイしたら、次の点を確認します。

- ヘルスチェックが通っている
- マイグレーションが完了している
- 主要なユーザーフローが動く

## 依存の更新

scaffold したアプリには、公開から 3 日たっていない版を取り込まないようにする `bunfig.toml` が入っています。

```toml
[install]
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = [
  "@guren/cli",
  "@guren/core",
  # scaffold した時点で公開されていた @guren のパッケージをすべて並べる
]
```

npm で乗っ取られたリリースの多くは、数時間から数日のうちに見つかって取り下げられます。3 日待ってから取り込めば、そうした版を入れてしまうことはまずありません。この設定は、Bun が版を選ぶとき（lockfile にまだない依存の `bun install` や `bun add`）に、直接の依存にも推移的な依存にも効きます。範囲を満たすのが 3 日未満の版だけだと、install は `blocked by minimum-release-age` で失敗します。範囲を広げるか、その版が 3 日たつのを待ってください。`bun.lock` にすでに入っている版には影響しません。

`@guren` のパッケージは名前で 1 つずつ並べています。Bun はここで `@guren/*` のようなスコープ指定を読まないうえ、Guren を更新すると門より新しいリリースを取り込むことになるためです。一覧には、scaffold した時点で公開されていた `@guren` のパッケージがプラグインも含めてすべて入っています。それより後に公開されたパッケージは、同じように名前で加えてください。

脆弱性の修正版が公開から 3 日たっていないときは、設定ごと外すのではなく、その版だけを通してから更新します。

```toml
minimumReleaseAgeExcludes = [
  # ...
  "some-package@1.2.4",
]
```

`bunfig.toml` に `minimumReleaseAge` がないときや、アプリが入れている `@guren` のパッケージが一覧から漏れているときは、`guren doctor` が `supply-chain-cooldown` として知らせます。`guren upgrade` を実行すると、この設定を書き足すか、漏れている名前を一覧に加えます。ただし、自分で書いた `[install]` の表や、1 行に 1 つずつではない形の一覧があるファイルには手を加えず、doctor が足すべき行を表示します。

インストール済みのパッケージに脆弱性情報があるかどうかは、`guren audit` を実行すると `bun audit` の結果として表示されます。指摘されたパッケージがどの直接の依存から入っていて、本番の install でも入るかどうかは、`guren deps:why <パッケージ名>` で確かめられます。どのルートから届くのか、サーバーとブラウザのどちらで動くのかは、`guren deps:exposure --package <パッケージ名>` で分かります。

`guren audit` は、脆弱性情報ごとに、影響する範囲に入るインストール済みの版と、それぞれに届くルートを表示します。内容は `deps:exposure` と同じ文書から読んでいます。`@guren` のパッケージを通してだけ入っている版には「reaches every route through @guren packages」と表示されます。どのルートから届くかを読み切れなかった版には「routes unknown」と表示され、レポートの最後の節に、どの読み取りが途中までだったかが出ます。範囲に入る版が見つからない脆弱性情報には、空のままにせず理由を表示します。`--json` では、`deps:*` の指摘ごとに `advisory`（GHSA と影響するすべての範囲）、`exposures`、一覧が空のときは `exposureReason` が付きます。

範囲に入るインストール済みの版がある脆弱性情報には、直し方も表示されます。アプリが直接依存しているパッケージなら、影響する範囲の外にある最も低い版が候補です。インストール済みの版と同じメジャーに候補があれば、それを選びます。別の依存から入っているパッケージなら、その直接の依存について、依存ツリーが範囲の外に出る最も低い版を探します。どの版でも出られない場合は、パッケージそのものの override を提案します。audit はそのあと、`package.json`、`bun.lock`、`bunfig.toml` を一時ディレクトリにコピーし、手順を当てて `bun install --lockfile-only` を実行します。解決後の lockfile に範囲内の版が残っていないときだけ、`verified` と表示します。コピーには公開からの経過日数の制限もそのまま入るので、公開から 3 日たっていない修正版はそこでも止まります。そのときは、`minimumReleaseAgeExcludes` に足す項目を公開日つきで手順に加えて、もう一度解決します。確かめられなかった直し方は、理由を添えて `candidate` と表示します。workspace の lockfile を共有しているアプリが、その一例です。`--no-fix` を付けると、npm レジストリを読むこの探索を省きます。

`bun audit` が見るのは npm のパッケージで、Bun 本体は対象外です。そこで `guren audit` は、アプリが動く Bun の版も確かめます。対象は、コマンドを実行している Bun、`package.json` の `engines.bun` と `packageManager`、アプリのルートにある Dockerfile の `oven/bun` のイメージです。それぞれを `oven-sh/bun` のリポジトリにある脆弱性情報と突き合わせます。`bun audit` が読むデータベースには、このリポジトリの情報が載っていないことがあるためです。範囲に入る版があれば、修正済みの版を添えた `deps:runtime:<GHSA>` の指摘になります。canary は、その次に出るリリースより前の版として扱います。版を 1 つに決めないイメージの指定（`oven/bun:1`）や、digest の付いていない指定は、作り直すたびに別の Bun になりうるので、`deps:runtime-unpinned` の警告になります。`guren deploy` が書くのは `oven/bun:<version>@sha256:…` の形です。脆弱性情報は `api.github.com` から読み、トークンなしでは 1 時間に 60 回までしか読めないので、CI では `GITHUB_TOKEN` を渡してください。読めなかったときは、問題なしとはせず `deps:runtime-scan` を報告します。`guren deps:exposure` も、同じ版を「Bun runtime」の下に表示します。

`guren audit` と `guren deps:exposure` は、どちらも最後に「What these results rest on without checking」という節を出します。結果が確かめないまま頼っているものの一覧で、その実行で実際に読んだものから組み立てるので、実行しなかった確認を済んだことにはしません。`--no-deps` で実行したときは、Bun 本体を確かめていないと書かれます。並ぶのは次のものです。

- Bun 本体の脆弱性情報の出どころ（`oven-sh/bun` のリポジトリだけ）と、版を 1 つに決めない版の指定やイメージのタグ
- アプリの import からは `@guren` のパッケージを通してしか届かず、どのルートにも結び付けていないパッケージの数
- その実行で途中までしか読めなかった読み取り（どのファイルにも解決しない import、解決できなかったグラフの項目（関係と行き先つき）、列のルールが追えなかったレスポンスの値など）
- `candidate` のままの直し方と、その理由
- lockfile の integrity ハッシュ（確かめるのは install 時の Bun で、Guren は確かめません）

`--json` では、同じ項目が `trustBoundary` に入ります。各項目には、どの読み取りや手順の話かを示す `from` と、`message` が付きます。

### 新しい脆弱性情報に気づく

最後のデプロイのあとに公開された脆弱性情報は、だれかが audit を実行し直すまで気づかれません。定期実行のワークフローを置いておくと、公開された日のうちに分かります。まず、いまのレポートを基準としてコミットします。

```bash
bunx guren audit --json > audit-baseline.json
```

そのうえで、毎日この基準と比べて audit を実行します。

```yaml
name: Dependency advisories
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx guren audit --deps-baseline audit-baseline.json
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`--deps-baseline` を付けると、脆弱性情報の指摘のキーが基準のファイルに無いときと、依存パッケージのスキャンか Bun の版の確認が最後まで終わらなかったときに exit 1 になります。Bun 本体の脆弱性情報も、指摘のキーとして数えます。レジストリや GitHub に届かなかった日も、成功ではなく失敗として残ります。基準のファイルには、以前の `guren audit --json` のレポートか、指摘のキーを並べた JSON の配列を使えます。パスはアプリのディレクトリから見た位置で書きます。`config/audit.ts` で無視している脆弱性情報は、新しいものとして数えません。このフラグは終了条件を足すだけなので、high か critical の脆弱性情報は、基準のファイルにあってもなくても `guren audit` を失敗させます。当面そのままにすると決めたものは理由を添えて `config/audit.ts` に書き、修正のたびに基準のファイルを作り直してください。
