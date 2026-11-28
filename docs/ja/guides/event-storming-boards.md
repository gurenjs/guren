# イベントストーミングのボード

ボードは、計画を書く前の段階で変更の形を探るための場所です。ドメインにどんなイベントがあり、誰が何をきっかけに起こし、その後に何が続くのか、そしてまだ何が決まっていないのかを付箋で並べていきます。人は Dev Center のキャンバスで付箋を動かし、エージェントは同じボードを文章として読み書きします。形が固まったら、ボードを材料に[実装計画](./implementation-plans.md)を書きます。

ボード自体には何の効力もありません。ボードが原因で落ちる検査はなく、承認もなく、ボードから実行されるものもありません。ボードから書いた計画は、ほかの計画と同じように検査と承認を通ります。

## ボードを作る

```bash
bunx guren board:new "Post notifications"
```

ボードは `docs/boards/post-notifications.board.json` に書かれるので、ほかの変更と一緒にコミットします。slug は題名から作られます。英数字を含まない題名には `--slug` を付けてください。

```bash
bunx guren board:new "投稿の公開通知" --slug post-notifications
```

キャンバスのボタンの言葉は、付箋を書く言語に合わせて英語か日本語になります。`--locale` で指定でき、省くとアプリの既定のロケールになります。

## 付箋の種類

付箋には種類があり、イベントストーミングで使われる色で描かれます。

| 種類 | 色 | 表すもの |
|---|---|---|
| `actor` | 黄 | 操作する人や役割 |
| `view` | 緑 | その人が見る画面 |
| `command` | 青 | アプリに頼む操作 |
| `aggregate` | 薄い黄 | 操作で変わるレコード |
| `event` | 橙 | 起きたこと |
| `reaction` | 薄紫 | イベントの後に続くこと（リスナー、ジョブ、メールなど） |
| `external` | 桃 | アプリの外のシステム |
| `question` | 赤 | まだ決まっていないこと |

イベントストーミングでは薄紫の付箋をポリシーと呼びます。Guren ではポリシーが認可のクラスを指すので、この種類は `reaction` という名前にしています。

## Dev Center で並べる

Dev Center を有効にしてアプリを起動し（雛形の `bun run dev` は `GUREN_MCP=1` を設定済みです）、`http://localhost:3333/_guren/boards` を開きます。ポートはアプリに合わせてください。Dev Center のトップにもボードの一覧が出ます。

ボードのページでできる操作は次のとおりです。

- **付箋を足す**: **付箋を追加** を押して種類を選びます。何もないところをダブルクリックすると、最後に使った種類の付箋が足されます。**つなぐ**、**非同期**、**削除** のボタンは、使えるものを選んでいる間だけその隣に出ます。
- **動かす**: 付箋をドラッグします。囲みの中に置くとその囲みに入り、外へ出すと抜けます。Shift を押しながらクリックすると複数を選べ、まとめて動かせます。
- **文言を直す**: 付箋をダブルクリックするか、選んで Enter を押します。
- **つなぐ**: 1 枚目を選んで C（または **つなぐ**）を押し、2 枚目をクリックします。矢印を選んで **非同期** を押すと、キューに入るジョブのように呼び出し側が待たない手順を表す破線になります。
- **付箋について問う**: 問いの付箋をほかの付箋に重ねます。問いはその付箋の隣に移り、点線で結ばれます。
- **囲み**: 付箋をまとめます。名前の部分をドラッグすると中の付箋ごと動き、右下の角をドラッグすると大きさが変わります。
- **消す・戻す**: **削除** で選んだものを消し、Ctrl か ⌘ を押しながら Z で直前の編集を取り消します。取り消すと、その編集で変えた部分のうち、その後だれも変えていない部分だけが元に戻ります。その間にエージェントが変えた部分は残ります。エージェントが先に消していた付箋を消そうとしたときのように、ファイルに反映されなかった編集は取り消しの対象になりません。

キーボードでは、Tab で付箋と囲みの名前を順に移ります。矢印キーで選んだものを動かし（Shift を押すと大きく動きます）、Enter で編集、Delete で削除です。2 枚の付箋をつなぐときは、1 枚目で C を押し、Tab で 2 枚目に移って Enter を押します。矢印の選択、複数の付箋の選択、囲みの大きさの変更にはマウスなどのポインターが要ります。

背景をドラッグすると全体が動き、Ctrl か ⌘ を押しながらホイールを回すと拡大・縮小します。キャンバス右下のボタンでも拡大・縮小できます。編集はそのたびにボードのファイルへ保存されます。ウィンドウに戻るとページがファイルを読み直すので、その間にエージェントが足した付箋も表示されます。

## エージェントに読み書きさせる

エージェントは同じボードを文章として扱います。`board:show` を実行するとアウトラインが表示され、囲みごとの付箋が流れの順に並び、矢印は出ていく側の付箋の行に書かれます。

```bash
bunx guren board:show post-notifications
```

```text
Board: Post notifications  (docs/boards/post-notifications.board.json)

Publishing [publishing]
  [actor author] Author  -> publish_post
  [command publish_post] Publish a post  -> post
  [aggregate post] Post  -> post_published
  [event post_published] Post was published  ~> tell_subscribers
      ? [draft_too] Notify for a saved draft too?
  [reaction tell_subscribers] When published, tell subscribers
```

`~>` は非同期の矢印で、問いはそれが指す付箋の下に出ます。アウトラインに座標は出ず、座標から意味を読み取る仕組みもありません。

ボードを編集するときは、`board:apply` に操作の列を渡します。付箋の id はエージェントが決めます。座標を付けずに足した付箋は、`after` に挙げた付箋の隣か、`section` に挙げた囲みの中に置かれます。

```bash
bunx guren board:apply post-notifications --ops ops.json
```

```json
[
  { "op": "add", "id": "post_updated", "kind": "event", "text": "Post was updated", "after": "post_published" },
  { "op": "connect", "from": "publish_post", "to": "post_updated" }
]
```

操作は `add`、`edit`、`move`、`remove`、`connect`、`disconnect`、`link`、`section`、`unsection` の 9 つです。もう無い付箋を指す操作のように適用できないものは、理由を報告して飛ばし、残りは適用します。そのため、人とエージェントが同じボードを同時に編集しても、互いの編集は消えません。Dev MCP のエンドポイントにつないだエージェントは、`guren_get_boards` ツールでもボードを読めます。

雛形のアプリに入るエージェントのハーネスには、エージェントと一緒にセッションを進めるための `event-storming` スキルがあります。「投稿の公開通知をイベントストーミングしたい」のように頼むと、エージェントは次の 4 段階で進め、段階ごとに止まります。そのたびにキャンバスかチャットでボードを直せます。

1. イベントだけを書き出す
2. イベントを起こすコマンドと、それを出すアクター、変わる記録、使う画面を足す
3. 各イベントの後に続くリアクションと、それが届く外部のシステムを足す
4. まだ決まっていないことを、1 つずつ問いの付箋にする

ボードが固まったと伝えると、スキルは次の節のとおりにボードを計画へ渡し、計画を承認する前に link ごとボードをコミットします。

## ボードから計画へ

ボードが落ち着いたら、ボードを含めた計画用のプロンプトを表示して、エージェントに渡します。

```bash
bunx guren plan --from-board post-notifications --print-prompt
```

プロンプトには依頼の後にボードのアウトラインが引用されます。引用符で囲んで自分の依頼を書き足すこともできます。付箋が計画のどの要素になるかも、プロンプトでエージェントに伝わります。

| 付箋 | 計画での扱い |
|---|---|
| `event`、`reaction` | 副作用。きっかけは、その付箋に入ってくる矢印から書かれます |
| `command` | ルートと、それが呼ぶアクション |
| `aggregate` | モデル |
| `view` | ビュー |
| `question` | 計画の問い。対象の付箋から作られた要素が影響先になります |
| 囲み | フロー |

変更に要らないと分かった付箋は、計画の対象外（non-goals）に入ります。その先は計画の検査、レビューのページ、承認の流れになります。[実装計画](./implementation-plans.md)を参照してください。

計画が `plan:render` を通ったら、エージェントは `link` 操作で、どの付箋がどの要素になったかを記録します。link は計画と同じ名前で要素を指します。モデルはクラス名、ルートは名前、アクションは `Class.action`、ビューはページ、副作用はクラス名です。コマンドの付箋はルートに link し、アクターと問いには link を付けません。

```json
[{ "op": "link", "id": "post_published", "link": { "kind": "event", "name": "PostPublished" } }]
```

計画からボードへの参照はないので、ボードを消しても付箋を動かしても、計画とその承認はそのまま残ります。

## 付箋の行き先を確かめる

`board:status` を実行すると、link のある付箋ごとに、その要素があるかどうかが表示されます。

```bash
bunx guren board:status post-notifications --plan docs/plans/post-notifications/plan.json
```

```text
Board: Post notifications  (docs/boards/post-notifications.board.json)
Plans: docs/plans/post-notifications/plan.json (given)

Linked notes:
  present   [aggregate post] Post  = model Post
  planned   [event post_published] Post was published  = event PostPublished  (docs/plans/post-notifications/plan.json)
  missing   [command publish_post] Publish a post  = route posts.publish

Lead nowhere (2):
  [command publish_post] Publish a post  = route posts.publish (missing)
  [reaction tell_subscribers] When published, tell subscribers  (no link)
```

`present` はアプリに要素があること、`planned` は計画がその要素を足すこと、`missing` はどちらにもないことを表します。`unknown` は、アプリか計画の一部を読めず判断できなかったことを表します。**Lead nowhere**（行き先のない付箋）には、`missing` の link と、link を付けられるのに付いていない付箋が並びます。アクターと問いは含みません。`--plan` を付けないときは、承認済みでまだ閉じていない計画を読みます。付けると、承認の有無にかかわらずその計画を 1 つだけ読みます。人がレビューする前に、エージェントが自分の付けた link を確かめるのはこの形です。アプリは `plan:status` と同じように読むので、`db/schema.ts` とバリデーターが読み込まれます。結果を表示するだけなので、ボードと計画を読めれば終了コードは 0 です。

Dev Center のボードのページでも、同じ結果が付箋の上に表示されます。link のある付箋には **実装済み**、**計画中**、**見つからない**、**判定できない** のいずれかの印が付き、キャンバスの下の行に件数と読んだ計画が出ます。確かめるのは、ボードを開いたとき、**Refresh board** を押したとき、ウィンドウに戻ったときで、ウィンドウに戻ったときは前回から 15 秒以上たっている場合に限ります。計画は `--plan` を付けないときと同じく、承認済みでまだ閉じていないものを読みます。前回確かめた後で link を変えた付箋には、次に確かめるまで印が出ません。

## 上限

1 枚のボードに置けるのは、付箋 500 枚、矢印 2,000 本、囲み 100 個までです。付箋の文言は改行を含まない 280 文字以内です。付箋が 500 枚あってもキャンバスの動作は重くならず、付箋はドラッグに遅れず動きます。指を離すと、保存がサーバーに届く前に 15 ミリ秒ほどでボードが描き直されます。
