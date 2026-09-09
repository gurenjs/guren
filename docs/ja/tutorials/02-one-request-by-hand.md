# 第 2 章: リクエストをひとつ、手で

第 1 章で手に入れたアプリには、自分では書いていないページがひとつありました。この章では次のページを空のファイルから、以降のコースで使う順序どおりに書きます。失敗するテスト、ルート、コントローラー、ページの順です。そのあと 2 つ目のページをテストで仕様化してエージェントに委ね、ハーネスが編集中のファイルに合わせて rule を読み込む動きを確認します。

**この章で学ぶこと:**

- リクエストが `routes/web.ts` からコントローラーのメソッドを経て `Response` になるまでの道筋
- 素の Response と Inertia ページの違い、それぞれで十分な場面
- `bun run codegen` がページの `Props` から導出するものと、`pages.about.Index` がコンパイル時の名前になっている理由
- ルートに名前を付け、型付きの `route()` ヘルパーでリンクする方法
- ハーネスの glob スコープ rule が、そのファイルを編集するときにだけエージェントへ届く仕組み

開発サーバーを止めていたら起動し、専用のターミナルで動かしたままにしてください。

```bash run background
bun run dev
```

## 1. まずテスト

ページはまだ存在しません。何をすべきかを先に書きます。

```ts file=tests/AboutController.test.ts
import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('AboutController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('serves the about page', async () => {
    const response = await http.get('/about').assertOk()
    await response.assertBodyContains('About Guren Blog')
  })
})
```

```bash run expect-fail
bun test
```

新しいテストは 404 で失敗します。`/about` に応えるものがまだ無いからです。第 1 章の 2 件は通ったままです。ここから一層ずつ書き足して、この新しいテストを通していきます。

## 2. ルート

ルートはメソッドとパスをコントローラーのアクションに対応付けます。`routes/web.ts` を置き換えます。

```ts file=routes/web.ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

新しい点が 2 つあります。`[AboutController, 'index']` は、ハンドラー関数の代わりにクラスとメソッドを指名しています。Guren はリクエストごとにコントローラーをインスタンス化するので、メソッドは `this` を通してリクエストを読めます。もうひとつは `.name('about')` で、ルートに名前を付けます。URL は変わりますが、ページがリンクに使うのは名前のほうです。

もう一度テストを走らせると、今度は別の理由で失敗します。`AboutController` の import が解決できず、アプリが起動できません。`guren check` も見つける類の問題ですが、ここではテストが先に捕まえました。

## 3. コントローラー、まずは素の Response で

`app/Http/Controllers/AboutController.ts` を作ります。

```ts file=app/Http/Controllers/AboutController.ts
import { Controller } from '@guren/core'

export default class AboutController extends Controller {
  async index(): Promise<Response> {
    return this.text('About Guren Blog')
  }
}
```

```bash run
bun test
```

緑になりました。コントローラーのアクションは `Response` を返すメソッドで、`this.text()` は素の Response を組み立てます。契約はこれだけです。ページを挟まない形で一度見ておく価値があります。コントローラーの他のすべて(`this.inertia()`、`this.json()`、`this.redirect()`、第 4 章で出会うバリデーター)も、同じ `Response` を組み立てる別のやり方だからです。

[http://localhost:3333/about](http://localhost:3333/about) を開いてください。約束どおり、プレーンテキストです。

## 4. 次はページ

素の Response はヘルスチェックや webhook には最適です。ページには HTML が必要で、Guren ではそれが Inertia ページにあたります。`resources/js/pages/` 配下の React コンポーネントで、props はコントローラーから受け取ります。作りましょう。

```tsx file=resources/js/pages/about/Index.tsx
import { Head, Link } from '@inertiajs/react'

interface Props {
  title: string
  description: string
}

export default function AboutIndex({ title, description }: Props) {
  return (
    <>
      <Head title={title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            {title}
          </h1>
          <p className="text-lg text-g-text-2">{description}</p>
          <Link href="/" className="text-sm text-g-accent-text transition hover:underline">
            Back to the front page
          </Link>
        </div>
      </main>
    </>
  )
}
```

コンポーネントの `Props` インターフェースは React だけのためのものではありません。codegen がこれを読み、`about/Index` というページが `title` と `description` の 2 つの文字列を受け取ると記録します。マニフェストを再生成しましょう。

```bash run
bun run codegen
```

`.guren/pages.gen.ts` に `pages.about.Index` ができ、`this.inertia()` は一致しない props を拒否するようになります。コントローラーをページに向けます。

```ts file=app/Http/Controllers/AboutController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class AboutController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(pages.about.Index, {
      title: 'About Guren Blog',
      description: 'A blog built chapter by chapter, by hand and by agent.',
    })
  }
}
```

```bash run
bun test
```

まだ緑ですが、今度は狙いどおりの理由で緑です。コントローラーがタイトルを prop として送ったので、本文にタイトルが含まれています。ブラウザで `/about` をリロードすると、まずサーバーでレンダリングされたページが表示され、そのあとブラウザ側で React が引き継ぎます。試しにコントローラーから `description` を消して `bun run typecheck` を走らせてみてください。エラーがページ名と欠けている prop を名指しします。確認したら戻しておきましょう。

この節から持ち帰るものは 3 つです。

- **ページ名はファイルパスです。** `resources/js/pages/about/Index.tsx` が `pages.about.Index` です。ファイルを改名すれば次の codegen で名前も変わり、古い名前を使っていたコントローラーはすべてコンパイルできなくなります。
- **props が契約です。** コントローラーはページが宣言したとおりのものを送ります。形が書かれている場所は他にありません。
- **codegen は手で覚えて実行するビルド手順ではありません。** `bun run dev` が起動時に実行し、ルート、ページ、リソースの変更を監視します。`bunx guren gate` も最初に実行します。ここで手動で走らせたのは、動きを見るためです。

変更全体を確かめてコミットします。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the about page"
```

## 5. 次のスライスを仕様化する

同じ作り方の contact ページです。今度はテストだけを書きます。

```ts file=tests/ContactController.test.ts
import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

describe('ContactController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('serves the contact page', async () => {
    const response = await http.get('/contact').assertOk()
    await response.assertBodyContains('Contact')
    await response.assertBodyContains('hello@guren-blog.test')
  })
})
```

```bash run expect-fail
bun test
```

赤です。このテストが仕様です。誰がページを作ろうと、これが通れば完成です。

委ねる前に知っておくことがひとつあります。テストランナーの中では、ページは HTML にレンダリングされません。レスポンスが運ぶのはページ名とその props で、`assertBodyContains` が検索するのもそこです。テストから見えるのはコントローラーが*送る*内容までで、コンポーネントが*書く*内容は見えません。だからアドレスは prop にする必要があります。これは回避すべき制約というより、コンテンツをどこに置くべきかをテストが示していると考えてください。第 1 章のタグラインが prop だったのも同じ理由です。

## 6. 委ねる

`guren-blog` の中でエージェントに頼みます。

> Add a `/contact` page the way `/about` was built: a `ContactController` with an `index` action that sends `title: 'Contact'` and `email: 'hello@guren-blog.test'` as props, a page at `resources/js/pages/contact/Index.tsx` that shows the title as a heading and the email as a mailto link, and a route named `contact` in `routes/web.ts`. `tests/ContactController.test.ts` already describes it; make it pass.

作業中は、この章のハーネス要素にも注目してください。エージェントのコンテキストが、常にすべての rule を抱えているわけではありません。`.claude/rules/routes-codegen.md` の冒頭はこうなっています。

```markdown
---
description: Guren routing & codegen — RouteContractOptions, schema binding, the Zod→ApiRoutes matrix, middleware
globs:
  - "routes/**"
  - "app/Http/Validators/**"
---
```

肝は `globs` の行です。この rule が読み込まれるのは、エージェントが `routes/` 配下のファイルを編集するときだけです。`controllers-http.md` は `app/Http/**` に対して同じように働きます。だからエージェントが `routes/web.ts` を開いた時点で、`router.get(...)` の正確な形、options オブジェクト、`.name()` が、このバージョンのフレームワークで検証済みの内容として、必要なタイミングで手渡されます。正しい定義が目の前にあるので、記憶を頼りにルート API をでっち上げることもありません。さらにファイルを保存すると `PostToolUse` hook が `guren check` を走らせ、存在しないコントローラーメソッドを指すルートがあれば報告します。

**手元にエージェントが無い場合は、** 3 ファイルです。(エージェントは `bunx guren make:controller Contact` から始めるかもしれません。これは `pages.contact.Index` をレンダリングするコントローラーの骨組みを書きます。その習慣については第 3 章で扱います。)

```ts file=app/Http/Controllers/ContactController.ts fallback
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class ContactController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(pages.contact.Index, {
      title: 'Contact',
      email: 'hello@guren-blog.test',
    })
  }
}
```

```tsx file=resources/js/pages/contact/Index.tsx fallback
import { Head, Link } from '@inertiajs/react'

interface Props {
  title: string
  email: string
}

export default function ContactIndex({ title, email }: Props) {
  return (
    <>
      <Head title={title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            {title}
          </h1>
          <p className="text-lg text-g-text-2">
            Write to <a href={`mailto:${email}`} className="text-g-accent-text hover:underline">{email}</a>.
          </p>
          <Link href="/" className="text-sm text-g-accent-text transition hover:underline">
            Back to the front page
          </Link>
        </div>
      </main>
    </>
  )
}
```

```ts file=routes/web.ts fallback
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

どちらの場合も、再生成して仕様を走らせます。

```bash run
bun run codegen
```

```bash run
bun test
```

受け入れる前にレビューします。rubric は次のとおりです。

- `routes/web.ts` の追加は、`contact` と名付けた `GET /contact` ルート 1 行とその import だけ。他は動いていない。
- `ContactController` はアクションひとつでページをレンダリングしている。HTML を手で組み立てたり `this.text()` を返したりしていない。
- アドレスはコントローラーが送る prop になっていて、ページに文字列でハードコードされていない。`resources/js/pages/contact/Index.tsx` は両方の prop を `Props` インターフェースで宣言している。
- `tests/ContactController.test.ts` は手つかずで緑、他もすべて緑。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the contact page"
```

## いまいる場所

- リクエストひとつをすべての層で追い、各層を自分で書きました。
- codegen がページから何を導出するか、ページ名と props がコンパイル時に検査されることを知りました。
- 存在しないページをテストで仕様化し、委ね、rubric に照らして受け入れました。
- rule が、頼んだからではなく開いたファイルに応じてエージェントへ届くことを確認しました。

## よくあるつまずき

- **`pages.about.Index` が存在しない。** ページを作ってから codegen が走っていません。`bun run codegen` を実行するか、`bun run dev` に任せてください。開発サーバーは、動作中にページが追加されると再生成します。
- **テストは通るのにブラウザは古いページを表示する。** 最後の保存前に開発サーバーがレンダリングし、Inertia が古い props を保持しています。キャッシュを無効にしてリロードするか、`bun run dev` を動かしているターミナルで codegen のエラーを確認してください。
- **エージェントが HTML 入りの `this.text()` を返してきた。** 動きますし、テストも通ります。rubric がテストの検査項目だけでなくコントローラーのあるべき姿まで書いているのは、そのためです。ページをレンダリングするよう頼み直してください。このコースで何度も繰り返すことになる修正です。
- **`guren check` がコントローラーにテストが無いと警告する。** `tests/<Name>Controller.test.ts` を探しています。両方書きましたね。別のコントローラー名が出ているなら、それは第 3 章の仕事です。

## 演習

1. `/health` はコントローラーを介さないインラインのハンドラーです。ブランチを切って、現在時刻を返すインラインのルートをもう 1 本足してください。そのうえで、コントローラーのアクションの代わりにこの書き方を選ぶと何を失うかを答えてください。
2. `this.inertia(pages.about.Index, …)` は文字列ではなく、生成されたコードからページを受け取ります。存在しないページに書き換えて、TypeScript のエラーを読んでください。そのエラーこそが `pages.*` の存在理由です。読んだら戻してください。

## 次へ

[第 3 章: posts テーブル](./03-the-posts-table.md) では、最初のデータベーステーブルとモデル、それを読む 2 つのページを追加し、作成フォームをエージェントに委ねます。
