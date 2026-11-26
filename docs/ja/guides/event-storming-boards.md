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

## ボードから計画へ

ボードが落ち着いたら、ボードを示して計画を頼みます。

```text
Read the board with `bunx guren board:show post-notifications` and write an implementation plan from it.
Every event and reaction becomes a side effect, every command a route and an action, and every open question a plan question.
```

その先は計画の検査、レビューのページ、承認の流れになります。[実装計画](./implementation-plans.md)を参照してください。

## 上限

1 枚のボードに置けるのは、付箋 500 枚、矢印 2,000 本、囲み 100 個までです。付箋の文言は改行を含まない 280 文字以内です。付箋が 500 枚あってもキャンバスの動作は重くならず、付箋はドラッグに遅れず動きます。指を離すと、保存がサーバーに届く前に 15 ミリ秒ほどでボードが描き直されます。
