# 第 13 章: 古びないドキュメント

どのプロジェクトにも、中身が実態と合っていない `README` がひとつはあるものです。誰かが悪意で書いたわけではなく、書いた時点では正しかったのに、その後コードだけが変わり、何もエラーにならなかったために放置されてきました。原因はこれだけで、対策は 2 つに分けて考えられます。

1 つ目は、コードから*導出*できるドキュメントです。ER 図は `db/schema.ts` とモデルのリレーションを図にしたものなので、人が手で書く必要はありません。Guren はこうしたドキュメントを生成し、コミット済みのものがコードと合わなくなった時点でビルドを失敗させます。

2 つ目は、誰にも生成できないドキュメントです。コメントが投稿と一緒に連鎖して削除される(cascade)理由、アップロードを非公開のディスクに置く理由、このアプリで「公開済み」が何を指すのか。こうした内容はコードを書くに至った理由なので、コードのどこにも残っていません。こちらは人が書き、Guren はドキュメントが対象として挙げているものが今も存在するかを確かめます。

**この章で学ぶこと:**

- フレームワークが導出できるドキュメントと、人にしか書けないドキュメントの違い
- 図を CI で検査できるものにする方法
- エンティティのドキュメントに何を宣言するかと、それがモデルを触る前のエージェントに届く仕組み
- 全体をコードと食い違わせないための、ひとつだけの保守ルール

## 1. 導出される半分

ジェネレーターはコードを読んでドキュメントを作るので、先に生成コードを最新にしておきます。

```bash run
bun run codegen
```

```bash run
bunx guren spec:generate
```

`docs/spec/` の下に 4 つのファイルができます。どれも、アプリにすでにあるものを別の角度から見たビューです。

| ファイル | 導出元 |
|---|---|
| `er.md` | `db/schema.ts`: テーブル、カラム、キー、そのあいだの外部キー、そしてモデルのリレーションが宣言するエッジ |
| `domain.md` | `app/Models/`: クラス、それぞれが何なのか、そしてクラスどうしのリレーション |
| `screens.md` | ルート、コントローラー、ページ: すべてのルート、その背後のアクション、そして渡す props とともにレンダリングするページコンポーネント |
| `modules.md` | すべてのソースファイルの import: アプリのどの部分がどこに依存しているのか |

`docs/spec/er.md` を開いてみてください。mermaid の図と、テーブルごとの表が並んでいます。`posts`、`users`、`comments`、`tags`、`postTags` (`post_tags` テーブル)、`links`、`attachments` が載っているのは、これまでの章でそれらをコードに書いたからです。誰かが説明を書き足したわけではありません。続けて `docs/spec/screens.md` を開き、第 4 章で作ったページを探してください。`Props` 型が、アプリのソースからそのまま引用されています。

どのファイルも、編集しないよう求める 1 行と、自動生成されたことを示す frontmatter から始まります。どちらも書かれているとおりの意味です。次の節では、この 1 行目を無視して手で編集すると何が起きるかを確かめます。

```bash run
bunx guren check --spec
```

4 件とも `pass`(合格)になり、どのファイルもいま生成し直した結果と一致していることが分かります。これらはコミットしておきます。生成したファイルをコミットしなければコードと食い違うこともありませんが、レビューの対象にもなりません。

```bash run
git add -A
git commit -m "docs: generate the spec views"
```

## 2. ゲート

生成したファイルをコミットしておけば、システムの構造が変わったときにレビューで diff として見えます。さらにそれを*チェック*することで、その diff を出し忘れることがなくなります。図を手で編集してしまった場合を試してみましょう。

```bash run
printf '\nThe posts table also stores a word count.\n' >> docs/spec/er.md
```

```bash run expect-fail
bunx guren check --spec
```

```bash manual
ERROR  [fail] docs/spec/er.md: docs/spec/er.md is out of date with the code.
       → Run: bunx guren spec:generate

Results: 3 passed, 0 warnings, 1 failures
```

このチェックは、現在のコードから 4 つのビューをすべてメモリ上で生成し直し、ファイルとバイト単位で比較しています。保存済みのハッシュと突き合わせる方式ではありません。そのため、手で足した 1 文でも失敗しますし、`db/schema.ts` にカラムを足して生成し直すのを忘れた場合もまったく同じように失敗します。内容を変えるにはコードを変えるしかないので、このドキュメントが実態と違う内容になることはありません。

```bash run
bunx guren spec:generate
```

```bash run
bunx guren check --spec
```

保守のルールは 1 行で書けます。**構造を変えたら生成し直し、その結果を変更と一緒にコミットする。** どの変更がどのビューに影響するかは、各ビューが何を読んでいるかで決まります。

| 変えたもの | 生成し直すもの |
|---|---|
| `db/schema.ts` | `er.md`、`modules.md` |
| モデル、またはそのリレーション | `er.md`、`domain.md`、`modules.md` |
| ルート、コントローラー、ページ | `screens.md`、`modules.md`(先に `codegen` を実行) |
| ソースファイルなら何でも | `modules.md` |

とはいえ最後の行があるので、実際にはこの表を覚えておく必要はありません。いつも `bunx guren codegen && bunx guren spec:generate` を実行しておけば済みます。このチェックは `guren gate` にも含まれているので、生成し忘れていないかは、コミット前に毎回実行しているゲートで確かめられます。

## 3. 誰にも生成できない半分

`comments` テーブルの行は、`posts` の行が消えると連鎖して削除されます(cascade)。スキーマにそう書いてあり、ER 図にも描かれています。しかし、ソフトデリートや孤児レコードとして残す方法ではなく連鎖削除を選んだ*理由*は、どちらにも書かれていません。これは設計上の決定なので、決定を記録する場所に書きます。

```bash run
bunx guren make:adr "Comments are deleted with their post" --entity Comment --by "human:you"
```

このコマンドは、雛形に最初から入っていた ADR の次の番号を振り、タイトルから slug を作り、リンクを埋めます。`--entity` を渡したので `entities: [Comment]` が入り、`related:` にはそのモデルに対応するコントローラー、リソース、ポリシーが並びます。コマンドが埋められないのは決定の根拠なので、そこは手で書きます。

```md file=docs/adr/0002-comments-are-deleted-with-their-post.md
---
type: adr
status: stable
entities: [Comment]
related:
  - app/Http/Controllers/CommentController.ts
  - app/Http/Resources/CommentResource.ts
  - app/Policies/CommentPolicy.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Comments are deleted with their post

## Context

A comment has no meaning without the post it answers. Keeping comments after
their post is gone leaves rows nothing can render, and every query that joins
them has to remember the case.

## Decision

`comments.postId` references `posts.id` with `onDelete: 'cascade'`. Deleting a
post deletes its comments, in the database, in one statement.

## Consequences

There is no "orphaned comment" state to design for, and no cleanup job. The
cost is that a post deletion is unrecoverable: an accidental delete takes the
discussion with it, and the only defence is the policy that decides who may
delete a post.
```

ADR は 1 つの決定を 1 度だけ書き、その後は手を入れないものです。frontmatter があることで、フォルダに置いただけのファイルとは違う役割を持ちます。`entities` と `related` には、この決定がどのエンティティやファイルに関わるかを書き、その内容はチェックで検証されます。

```bash run
bunx guren check --docs
```

`All 4 link(s) resolve.` と表示されます。4 つの内訳は、エンティティが 1 つとファイルが 3 つです。この ADR を直さずに `CommentPolicy.ts` をリネームすると、チェックはポリシーではなく ADR のほうを指摘します。リンクが切れて壊れたのはドキュメントだからです。

## 4. エンティティのドキュメントは何のためにあるのか

ADR が決定を記録するのに対して、context のドキュメントは対象そのものを説明します。このアプリで `Comment` とは何か、どんな前提が成り立つか、ルールはどこに書かれているか、といった内容です。エージェントには、モデルを触る前にこのドキュメントを読ませます。

```md file=docs/context/comments.md
---
type: context
status: stable
entities: [Comment, Post]
related:
  - app/Models/Comment.ts
  - app/Http/Controllers/CommentController.ts
  - app/Policies/CommentPolicy.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Comments

A comment belongs to one post and to the user who wrote it. Both are required
and both are set by the server from the route and the session, never from the
request body.

## Rules

- Anyone signed in may comment. Only the comment's own author may delete it,
  including the post's author, who has no special power over other people's
  comments. `CommentPolicy` is the only place that decides this.
- The body is trimmed and must not be empty; the message a reader sees for an
  empty comment lives in `CommentValidator`, not in the page.
- Deleting a post deletes its comments
  ([the decision](../adr/0002-comments-are-deleted-with-their-post.md)).

## Notifications

Posting a comment emits `CommentPosted`, which queues one mail to the post's
author unless the commenter *is* the post's author. The skip lives in the job,
so it applies to every future way a comment can be created.
```

今度はコードの側からドキュメントへつなぎます。ドキュメントの frontmatter がコードを指しているので、逆向きのリンクとしてコードに `@docs` タグを書きます。

```ts file=app/Http/Controllers/CommentController.ts
import { Controller } from '@guren/core'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPosted } from '../../Events/CommentPosted.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

/** @docs docs/context/comments.md */
export default class CommentController extends Controller {
  private isToolCall(): boolean {
    return this.ctx.req.header('X-Guren-Agent-Surface') !== undefined
  }

  async store(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('create', Comment)
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(CommentPayloadSchema)
    const comment = await Comment.forceCreate({ ...data, postId: post.id, authorId: author.id })
    await this.make('events').emit(new CommentPosted(comment.id))

    if (this.isToolCall()) {
      const fresh = await Comment.findWithOrFail(comment.id, 'author')
      return this.json({ comment: new CommentResource(fresh).toJSON() })
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    await Comment.delete({ id: comment.id })

    if (this.isToolCall()) {
      return this.json({ deleted: comment.id })
    }
    return this.redirect(`/posts/${comment.postId}`)
  }
}
```

```bash run
bunx guren check --docs
```

このタグもほかのリンクと同じくチェックの対象です。存在しないファイルを指すと、チェックはコントローラーの名前を挙げて失敗します。タグを読むのは `app/Models/` と `app/Http/Controllers/` の中だけで、これは意図した設計です。振る舞いを変えようとする人は、たいていこの 2 か所のどちらかを開くからです。

ここまで用意したものが何に使われるのかを確かめます。

```bash run
bunx guren context Comment
```

モデル、ルート、コントローラー、ポリシー、第 12 章で公開したツールの各セクションに加えて、**Linked docs** というセクションが増え、いま書いた 2 つのファイルが載っています。エージェントが `Comment` を扱うとき、ハーネスはこの出力をエージェントに渡します。ドキュメントがこの一覧に入ったのは `entities: [Comment]` の行があるからなので、本文よりも frontmatter のほうが効いてきます。

```bash run
bunx guren docs:graph --entity Comment
```

グラフは同じリンクを反対側からたどり、エンティティに関わるドキュメントと、それらをつなぐエッジを表示します。`--entity` で絞り込んだ場合、コードは表示されません。`bunx guren docs:graph --path app/Http/Controllers/CommentController.ts` のようにファイルを起点にすると、コードのノードと、そのコードに関わるドキュメントが一覧されます。ここに出てくるものはどれも、コードから導出されたものか、チェックで検証される frontmatter に宣言されたものです。そのため、別途覚えておく規約はありません。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "docs: record the comment decision and its context"
```

## 5. 残りを仕様化する

コメントのドキュメントはできましたが、いちばん多くの決定が詰まっている投稿のドキュメントはまだありません。「あとで書く」で済ませないよう、これをテストにしておきます。

```ts file=tests/Documentation.test.ts
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'

/** Every model a reader can reach has a context doc that names it. */
const DOCUMENTED = [
  ['Comment', 'docs/context/comments.md'],
  ['Post', 'docs/context/posts.md'],
] as const

describe('documentation', () => {
  for (const [entity, path] of DOCUMENTED) {
    it(`has a context doc for ${entity}`, async () => {
      const doc = await readFile(path, 'utf8')

      expect(doc).toContain('type: context')
      expect(doc).toContain(entity)
    })
  }
})
```

```bash run expect-fail
bun test
```

`docs/context/posts.md` がまだ無いので、テストは失敗します。

## 6. 委ねる

エージェントに次のプロンプトを送ります。

```text
Write `docs/context/posts.md`, a context document for the `Post` model, in the shape of `docs/context/comments.md`. Cover what a post is, who may change it, what publishing means, and how cover images and the gallery are stored and served. Also record the storage decision as an ADR with `bunx guren make:adr`, and link the two. `tests/Documentation.test.ts` and `bunx guren check --docs` both have to pass.
```

この章でハーネスが助ける方向は、これまでの章と逆です。ほかの章では、コードを書く前のエージェントにルールを渡していました。今回は、正しい内容を書くためにエージェントがアプリを*読む*必要があり、そのための手段がさきほど実行した 2 つのコマンドです。`guren context Post` で投稿が何に関わっているかが、`docs:graph` で何がすでに文書化されているかが分かります。どちらも読まずにもっともらしいドキュメントを書くと細部を間違えます。そして細部は、コードと突き合わせれば確かめられます。

**手元にエージェントが無い場合は、** 次のドキュメントを使ってください。

```md file=docs/context/posts.md fallback
---
type: context
status: stable
entities: [Post, User]
related:
  - app/Models/Post.ts
  - app/Http/Controllers/PostController.ts
  - app/Policies/PostPolicy.ts
  - config/attachments.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Posts

A post belongs to the user who wrote it. `authorId` is not null and is set by
the server from the session; it is never in `fillable` and never comes from a
form.

## Who may change one

`PostPolicy` decides, and every mutating action calls it. The author may
update, delete and publish; nobody else may do any of those, including through
the agent tools, which run the same policy on the same request.

## Publishing

`publishedAt` is null for a draft and a timestamp once published. Publishing
emits `PostPublished`, which mails everyone who commented on the post except
the author. There is no separate "status" column: the timestamp is the state,
and it doubles as the record of when it happened.

## Files

A post has one `cover` and many `images`, both declared on the model through
`Attachable`. Uploads are stored on the `local` disk, which is rooted outside
`public/`, and reach a browser only through a signed, expiring delivery route
([the decision](../adr/0003-uploads-are-served-from-a-private-disk.md)).
Deleting a post purges its attachments first, because the attachments table is
polymorphic and nothing cascades for it.

## Tags

Tags are a many-to-many through `post_tags`, written by deleting the post's
rows and recreating them. Normalisation (trim, lower-case, de-duplicate) is in
`PostValidator`, so `store` and `update` cannot disagree about what a tag is.
```

あわせて、保存先を決めた理由を記録する ADR も用意します。

```md file=docs/adr/0003-uploads-are-served-from-a-private-disk.md fallback
---
type: adr
status: stable
entities: [Post]
related:
  - config/attachments.ts
  - app/Models/Post.ts
generated: { by: "human:you", at: 2026-09-06T00:00:00Z }
---

# Uploads are served from a private disk

## Context

An upload is bytes a stranger chose. Anything under `public/` is served
statically by path, so a file there is readable by anyone who can guess or
learn its URL, forever, with no check of any kind.

## Decision

Attachments are stored on the `local` disk, rooted at `./storage/app`, which
nothing serves. `config/attachments.ts` declares that disk private and enables
the delivery route, so every URL the app hands out is signed and expires.

## Consequences

An image URL cannot be shared indefinitely, and a page that renders one has to
be re-rendered to mint a fresh link. In exchange there is no way to reach an
upload except through code that decided to hand it out, and `guren check`
fails the build if the disk is ever moved under `public/`.
```

```bash run
bun test
```

```bash run
bunx guren check --docs
```

確認項目は次のとおりです。

- `docs/context/posts.md` があり、`type` が `context` で、`entities` と `related` のリンクがすべて解決する。`guren check --docs` はすべてのリンクを報告するので、存在しないファイルを挙げた `related:` の項目は、見た目がもっともらしくても失敗として検出される。
- 書かれている内容がこのアプリの実態と合っている。`authorId` はサーバーが設定する、変更はポリシーが制限する、`publishedAt` がそのまま状態を表す、アップロードは非公開で署名付き URL で配信する、タグは中間テーブルを通す、という点が正しく書かれている。本文を検査する仕組みは無いので、コードと突き合わせて読む。
- ADR が、単なる説明ではなく、結果を伴う決定として書かれている。context のドキュメントのように読めるなら、書く場所を間違えている。
- context のドキュメントから ADR へのリンクがあり、どちらも `bunx guren docs:graph --entity Post` に表示される。

```bash run
bunx guren docs:graph --entity Post
```

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "docs: document posts and the private-disk decision"
```

## 7. 仕事そのものはどこにあるのか

これで、システムを説明するドキュメントは揃いました。一方で、*作業*を管理するドキュメントはあえて用意していません。`tasks.md` も計画のファイルも、`docs/` に置いた進捗の写しもありません。リポジトリにコミットしたタスクリストは、誰かがボードを更新した時点で古くなるからです。`README` と並んで、どのプロジェクトでもいつの間にか実態と合わなくなるものの代表です。

Guren では、frontmatter のフィールドを 1 つ使ってこれに対応します。作業項目は元の場所である GitHub で管理し、ドキュメントの側に、自分がどの項目に関係するかを書きます。

```md manual
---
type: adr
status: stable
entities: [Post]
issues: [412, "acme/blog#398"]
---
```

`make:adr` に `--issue` を渡すと、このフィールドを埋めてくれます。

```bash manual
bunx guren make:adr "Drafts expire after ninety days" --entity Post --issue 412
```

`guren check --docs` が検証するのは、各参照の書式だけです。issue 412 が実在するかを GitHub に問い合わせることはしません。このチェックはゲートの一部なので、ネットワークが必要だと飛行機の中などでは通らなくなってしまいます。`guren context Post` を実行すると、ドキュメントに宣言された issue が一覧されます。`guren context Post --live` はツールチェーンの中で唯一ネットワークにアクセスするコマンドで、各 issue の状態と担当者を表示します。ほかの人がすでに担当している作業に手を付ける前に確認できます。

YAML の書き方には注意してください。実際によく引っかかる点です。`issues: [412, #398]` と書くと、`412` より後ろがすべて消えます。引用符で囲まれていない `#` はコメントの始まりと解釈されるからです。引用符で囲むか、数字だけで書いてください。

## ここまでの状態

- アプリから生成した 4 つのビューがコミットされ、コードと合わなくなればビルドが失敗します。
- 生成できないドキュメントを 2 つ書きました。モデルや関連ファイルにリンクされ、そのリンクはチェックで検証されます。
- コントローラーにはドキュメントを指す `@docs` タグがあり、どちら側からもつながりをたどれます。
- エンティティのバンドル(`guren context Post`)が、コードと一緒に決定の記録も含むようになりました。エージェントは何かを変える前にこれを読みます。

## よくあるつまずき

- **`spec:generate` が警告を出し、ファイルを 3 つしか書かなかった。** ソースを読めなかったビューは、誤った内容で書き出す代わりにスキップされます。先に `bunx guren codegen` を実行してください。`screens.md` はルートグラフを import し、そのルートグラフが生成コードを import しています。
- **`spec:generate` の直後に `check --spec` が失敗する。** 2 つのコマンドの間に何かが変わったか、ビューを手で編集しています。これらのファイルは生成物なので、代わりにコードのほうを編集してください。
- **リネームしたらドキュメントのリンクが失敗するようになった。** 意図どおりの動きです。リネームと同じコミットで、`related:` の項目か `@docs` タグを更新してください。ファイルを移動する前に `bunx guren docs:graph --path <file>` を実行すれば、そのファイルに関わるドキュメントが分かります。
- **ドキュメントに frontmatter が無いと `check --docs` が警告する。** `docs/` 配下の Markdown のうち、概念を説明するドキュメント以外のものは、少なくとも `type:` で種類を宣言してください。例外は `index.md` と `log.md` の 2 つです。
- **`guren check` が失敗を表示したのに終了コードが 0 だった。** オプションなしの `check` は報告するだけです。終了コードを設定するのは `check --docs`、`check --spec`、`guren gate` です。ゲートはさらに厳しく、警告でも失敗します。ただし参考扱い(`advisory`)の警告は例外で、一部のクライアントが受け付けないツール名への警告などは `check` が表示するだけでゲートは数えません。
- **見直す予定の無いドキュメントに `stale_after:` を設定しない。** その日付を過ぎると警告が出続け、警告があるとゲートは失敗します。

## 演習

1. ブランチを切って `db/schema.ts` に列を足し、`bunx guren gate` を実行してください。4 つのビューのうち、コードと合わなくなったのはどれで、合ったままなのはどれですか。合ったままのビューについて、各ビューが何を読んでいるかから理由を説明してください。終わったら、ブランチだけでなく編集内容も破棄してください。
2. このアプリには、まだ記録されていない決定があります。タグの正規化をモデルではなくバリデーターで行っている点です。これを ADR に書いて `Post` にリンクし、`bunx guren check --docs` を通してください。そのうえで、コードを読むだけでは分からず、このファイルを読んで初めて分かることは何かを答えてください。

## 次へ

[第 14 章: 本番](./14-production.md) が最後の章です。再起動しても消えないセッション、レート制限、`NODE_ENV=production` で変わること、そしてこのアプリがまだ本番に耐えられない点の一覧を扱います。
