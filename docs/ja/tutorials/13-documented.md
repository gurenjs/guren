# 第 13 章: 古びないドキュメント

あなたがこれまで参加したプロジェクトには、どれも間違った `README` がありました。悪意があったわけではありません。誰かがそれがまだ正しかった時点で書き、コードのほうが動いていき、そして何も失敗しなかったのです。問題はそれがすべてで、それはちょうど 2 つの半分でできています。

ドキュメントの中には*導出*されるものがあります。ER 図は `db/schema.ts` と、モデルに書いたリレーションを描き出したものであって、誰も手で打つべきものではありません。Guren はそれらを生成し、そしてコミットされたコピーがコードと合わなくなったらビルドを失敗させます。

もう半分は、誰にも生成できません。なぜコメントが投稿と一緒に cascade するのか、なぜアップロードが非公開のディスクに置かれているのか、このアプリで「公開済み」が何を意味するのか。そのどれもコードの中にはありません。それは、コードを生んだ理由づけだからです。それらはあなたが書き、Guren は、そのドキュメントが対象だと主張しているものがまだ存在するかどうかを確かめます。

**この章で学ぶこと:**

- フレームワークが導出できるドキュメントと、あなたにしか書けないドキュメント
- 図を、CI が失敗できるものに変える方法
- エンティティのドキュメントが何を宣言するのか、そしてそれがモデルに触れる前のエージェントに届く仕組み
- その全体を正直に保ち続ける、たったひとつの保守のルール

## 1. 導出される半分

ジェネレーターはあなたのコードを読みます。なので、まずはそれが読む生成コードのほうを最新にしておきます。

```bash run
bun run codegen
```

```bash run
bunx guren spec:generate
```

`docs/spec/` の下にファイルが 4 つ。そのどれもが、すでにあなたが持っているものを写したビューです。

| ファイル | 導出元 |
|---|---|
| `er.md` | `db/schema.ts`: テーブル、カラム、キー、そのあいだの外部キー、そしてモデルのリレーションが宣言するエッジ |
| `domain.md` | `app/Models/`: クラス、それぞれが何なのか、そしてクラスどうしのリレーション |
| `screens.md` | ルート、コントローラー、ページ: すべてのルート、その背後のアクション、そして渡す props とともにレンダリングするページコンポーネント |
| `modules.md` | すべてのソースファイルの import: アプリのどの部分がどこに依存しているのか |

`docs/spec/er.md` を開いてください。mermaid の図と、テーブルごとの表でできています。ここが `posts`、`users`、`comments`、`tags`、`post_tags`、`attachments` を知っているのは、あなたがそれらを書いたからであって、誰かがそれらを説明したからではありません。`docs/spec/screens.md` を開いて、第 4 章で作ったページを探してください。その `Props` 型は、あなた自身のソースから引かれています。

どのファイルも、編集しないでくださいという 1 行と、これは処理が生成したものだと記録する frontmatter で始まります。どちらも本当のことです。そして次の節は、その 1 行目のほうを無視すると何が起きるかという話です。

```bash run
bunx guren check --spec
```

4 件の pass です。コミット済みのファイルはどれも、いま生成し直したら出てくるものと一致しています。コミットしてください。コミットされていない導出ファイルはドリフトしませんが、レビューされることもないからです。

```bash run
git add -A
git commit -m "docs: generate the spec views"
```

## 2. ゲート

生成ファイルをコミットする意味は、システムの形が変わったときにレビューへ diff が現れることです。それを*チェックする*意味は、その diff を忘れられなくすることです。図を手で編集してしまったことにしてみましょう。

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

このチェックは、保存しておいたハッシュとファイルを突き合わせているのではありません。いまのコードから 4 つのビューをすべてメモリ上で生成し直し、バイト単位で比較します。だから、手で足した 1 文で失敗しますし、`db/schema.ts` にカラムを足して生成し直すのを忘れたときも、まったく同じように失敗します。このドキュメントは間違えようがありません。変える方法が、コードを変えることしか無いからです。

```bash run
bunx guren spec:generate
```

```bash run
bunx guren check --spec
```

これが保守のルールで、1 行で済みます。**構造を変えたら、生成し直して、その結果を変更と一緒にコミットする。** どの変更がどのビューに触れるのかは、それぞれが何を読んでいるかから決まります。

| 変えたもの | 生成し直すもの |
|---|---|
| `db/schema.ts` | `er.md`、`modules.md` |
| モデル、またはそのリレーション | `er.md`、`domain.md`、`modules.md` |
| ルート、コントローラー、ページ | `screens.md`、`modules.md`(先に `codegen` を実行) |
| ソースファイルなら何でも | `modules.md` |

最後の行のおかげで、実際のところこの表は学問的なものになります。`bunx guren codegen && bunx guren spec:generate` を実行して、あとは勝手に片付けさせてください。`guren gate` がこのチェックを実行するので、「忘れていないか」の答えは、あなたがすでに毎回のコミット前に実行しているコマンドと同じです。

## 3. 誰にも生成できない半分

`comments` テーブルは `posts` から cascade します。スキーマがそう言っていますし、ER 図もいまやそれを描いています。けれどもそのどちらも、なぜソフトデリートでも孤児レコードでもなく cascade なのか、その*理由*は言いません。それは決定であり、決定には置き場所があります。

```bash run
bunx guren make:adr "Comments are deleted with their post" --entity Comment --by "human:you"
```

このコマンドは、アプリの雛形生成時に入っていた ADR の次の番号を振り、タイトルを slug にし、リンクを埋めました。`--entity` を渡したので `entities: [Comment]`、そして `related:` には、そのモデルについて見つけたコントローラー、リソース、ポリシーが入ります。埋められないのは、論拠のほうです。それはあなたが書きます。

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

ADR は決定ひとつぶんで、一度書いたら、あとは放っておくものです。それをフォルダの中の 1 ファイル以上のものにしているのが frontmatter です。`entities` と `related` は、この決定が何を統べるのかについての主張であり、そしてそれはチェックされます。

```bash run
bunx guren check --docs
```

`All 4 link(s) resolve.` 4 つとは、エンティティ 1 つとファイル 3 つのことです。この ADR に触れないまま `CommentPolicy.ts` をリネームすると、チェックはポリシーではなく ADR の名前を挙げます。壊れたのはドキュメントのほうだからです。

## 4. エンティティのドキュメントは何のためにあるのか

ADR は決定を記録します。context のドキュメントは、ものを記述します。このアプリで `Comment` とは何なのか、それについて何が真なのか、そしてルールがどこにあるのか。これこそが、エージェントがモデルに触れる前に読むべきドキュメントです。

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

今度はコードの側からつなぎます。ドキュメントの frontmatter はコードを指します。`@docs` タグは、そこから指し返します。

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

このタグも、ほかのすべてと同じようにチェックされます。存在しないファイルを指させれば、チェックはコントローラーの名前を挙げて失敗します。タグが読まれるのは `app/Models/` と `app/Http/Controllers/` の中だけですが、これは制限ではなく主旨です。振る舞いを変えようとしている人が行き着く場所が、この 2 つだからです。

では、これがすべて何のためだったのかを見てみます。

```bash run
bunx guren context Comment
```

モデル、そのルート、そのコントローラー、そのポリシー、そして第 12 章で公開したツールを記述する各セクションに並んで、いまや **Linked docs** があり、あなたがいま書いた 2 つのファイルが載っています。この出力こそが、`Comment` を扱うエージェントの前にハーネスが差し出すものです。そして、文章そのものより frontmatter のほうが効くのはこのためです。そのドキュメントをこの一覧に入れたのは `entities: [Comment]` だからです。

```bash run
bunx guren docs:graph --entity Comment
```

グラフは、同じリンクを反対の端から読みます。ドキュメント、エンティティ、コード、そしてそのあいだのエッジ。ここには、あなたが覚えておかなければならない規約はひとつもありません。ここにあるものはどれも、コードから導出されているか、チェックが検証する frontmatter で宣言されているかのどちらかだからです。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "docs: record the comment decision and its context"
```

## 5. 残りを仕様化する

コメントは文書化できました。背後にいちばん多くの決定を抱えているモデルである投稿は、まだです。それを、心づもりではなくテストにしてください。

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

赤です。`docs/context/posts.md` がありません。

## 6. 委ねる

> Write `docs/context/posts.md`, a context document for the `Post` model, in the shape of `docs/context/comments.md`. Cover what a post is, who may change it, what publishing means, and how cover images and the gallery are stored and served. Also record the storage decision as an ADR with `bunx guren make:adr`, and link the two. `tests/Documentation.test.ts` and `bunx guren check --docs` both have to pass.

これがこの章のハーネスのてこで、これまで見ていない向きに働きます。ほかのどの章も、エージェントがコードを書く前に rule を差し出しました。ここでは、エージェントは真実であるものを書くためにあなたのアプリを*読む*必要があり、そのために持っているコマンドは、いまあなたが実行した 2 つです。`guren context Post` は投稿が何に触れているのかを教え、`docs:graph` はすでに何が文書化されているのかを教えます。どちらも読まずにもっともらしいドキュメントを書いたエージェントは、細部を間違えます。そして細部はチェックできます。

**手元にエージェントが無い場合は、** こちらがそのドキュメントです。

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

そして、保存先の選択の背後にある決定です。

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

rubric は次のとおりです。

- `docs/context/posts.md` が存在し、その `type` が `context` で、`entities` と `related` がすべて解決する。`guren check --docs` はリンクを 1 本残らず報告するので、存在しないファイルを挙げたもっともらしい `related:` の項目は、誰にも気づかれない誤字ではなく失敗になる。
- 書かれている主張が、このアプリについて真である。`authorId` はサーバーが設定し、ポリシーが変更を門番し、`publishedAt` が状態そのもので、アップロードは非公開かつ署名付きで、タグは中間テーブルを通る。文章を検査するものは何も無いので、コードと突き合わせて読むこと。
- ADR が、記述ではなく、結果を伴う決定になっている。context のドキュメントのように読めるなら、それは置き場所が間違っている。
- 2 つが互いにリンクし合っており、どちらも `bunx guren docs:graph --entity Post` を生き延びる。

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

これで、システムを記述するドキュメントが手に入りました。意図的に持っていないのは、*仕事*を記述するドキュメントです。`tasks.md` も、計画のファイルも、`docs/` の中のステータスの写しもありません。これは見落としではありません。リポジトリにコミットされたタスクリストは、誰かがボードに触れた瞬間に古くなります。そしてこれが、どのプロジェクトにもある「いつも間違っているもの」の 2 つ目です。

Guren の答えは、frontmatter のフィールドひとつです。作業項目はすでにある場所、つまり GitHub にあり、ドキュメントのほうが、自分はそのどれに属するのかを言います。

```md manual
---
type: adr
status: stable
entities: [Post]
issues: [412, "acme/blog#398"]
---
```

`--issue` を渡せば、`make:adr` が代わりに埋めてくれます。

```bash manual
bunx guren make:adr "Drafts expire after ninety days" --entity Post --issue 412
```

`guren check --docs` が検証するのは、それぞれの参照の形だけで、それ以外は何も見ません。issue 412 が存在するかどうかを GitHub に問い合わせることは決してありません。このチェックはゲートであり、ネットワークを必要とするゲートは飛行機の中で失敗するゲートだからです。`guren context Post` は、そのドキュメントが宣言している issue を並べます。そして `guren context Post --live` は、ツールチェーン全体でただひとつネットワークに出るコマンドで、すでに誰かが抱えている仕事に手を付けてしまう前に、それぞれの issue の状態と担当者を報告します。

YAML には気を付けてください。ここは実際に噛みます。`issues: [412, #398]` は `412` より後ろをすべて失います。引用符の無い `#` はコメントの始まりだからです。引用符で囲むか、裸の数字で書いてください。

## いまいる場所

- 生成されたアプリのビューが 4 つ、コミット済み。そしてそれらがコードと合わなくなったら失敗するビルド。
- 誰にも生成できなかったドキュメントが 2 つ。モデルと、それが統べるファイルにリンクされていて、そのリンクはチェックされている。
- コントローラーからドキュメントへ指し返す `@docs` タグ。おかげで、そのつながりはどちらの端からも見える。
- コードと一緒に決定も運ぶようになったエンティティのバンドル(`guren context Post`)。エージェントが何かを変える前に読むのが、これです。

## よくあるつまずき

- **`spec:generate` が警告を出して、ファイルを 3 つしか書かなかった。** ソースを読めなかったビューは、間違ったまま書かれるのではなくスキップされます。先に `bunx guren codegen` を実行してください。`screens.md` はあなたのルートグラフを import し、それは生成コードを import します。
- **`spec:generate` の直後に `check --spec` が失敗する。** 2 つのコマンドのあいだで何かが変わったか、ビューを編集したかです。これらのファイルは出力です。代わりにコードを編集してください。
- **リネームのあとにドキュメントのリンクが失敗する。** それがこの機能の狙いです。リネームと同じコミットで `related:` の項目か `@docs` タグを更新してください。`bunx guren docs:graph --path <file>` は、ファイルを動かす前に、それを統べているものを教えてくれます。
- **ドキュメントに frontmatter が無い、と `check --docs` が警告する。** `docs/` 配下のマークダウンで概念のドキュメントでないものは、少なくとも `type:` でそう名乗るべきです。例外になる名前は `index.md` と `log.md` の 2 つです。
- **`guren check` が失敗を表示したのに 0 で終了した。** 素の `check` は報告するだけです。終了コードを設定するのは `check --docs`、`check --spec`、そして `guren gate` です。ゲートはさらに厳しく、警告でも失敗します。
- **見直すつもりの無いドキュメントに `stale_after:` を設定しないでください。** その日付以降ずっと警告が出ますし、警告はゲートを失敗させます。

## 次へ

[第 14 章: 本番](./14-production.md) が最後です。再起動を生き延びるセッション、レート制限、`NODE_ENV=production` が何を変えてくれるのか、そしてこのアプリがまだ足りていないものの正直な一覧です。
