# 第 2 章: リクエストをひとつ、手で

第 1 章で手にしたアプリには、あなたが書いていないページがひとつありました。この章では次のページを空のファイルから、以降のコースが使う順序で書きます。失敗するテスト、ルート、コントローラー、ページの順です。その後、2 つ目のページをテストで仕様化してエージェントに委ね、ハーネスが編集中のファイルに合った rule を読み込む様子を見届けます。

**この章で学ぶこと:**

- リクエストが `routes/web.ts` からコントローラーのメソッドを経て `Response` になるまでの道筋
- 素の Response と Inertia ページの違い、それぞれで十分な場面
- `bun run codegen` がページの `Props` から何を導出するのか、なぜ `pages.about.Index` がコンパイル時の名前なのか
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

新しいテストは 404 で失敗します。`/about` に答えるものが無いからです。第 1 章の 2 件は通ったままです。では新しいテストを、一層ずつ通していきましょう。

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

新しい点が 2 つあります。`[AboutController, 'index']` は関数ではなくクラスとメソッドを指名しています。Guren はリクエストごとにコントローラーをインスタンス化するので、メソッドは `this` を通してリクエストを読めます。そして `.name('about')` がルートに名前を付けます。URL は変わりますが、ページがリンクするのは名前です。

もう一度テストを走らせると、違う理由で失敗します。`AboutController` の import が解決できず、アプリが起動できないのです。それは `guren check` の仕事でもありますが、テストが先に見つけました。

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

緑です。コントローラーのアクションとは `Response` を返すメソッドで、`this.text()` は素の Response を組み立てます。それが契約のすべてで、ページが間に挟まらない形で一度見ておく価値があります。コントローラーの他のすべて(`this.inertia()`、`this.json()`、`this.redirect()`、第 4 章で出会うバリデーター)は、同じ `Response` を組み立てる別のやり方にすぎないからです。

[http://localhost:3333/about](http://localhost:3333/about) を開いてください。約束どおり、プレーンテキストです。

## 4. 次はページ

素の Response はヘルスチェックや webhook には正解です。ページには HTML が要り、Guren ではそれが Inertia ページです。`resources/js/pages/` 配下の React コンポーネントで、props はコントローラーから受け取ります。作りましょう。

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

コンポーネントの `Props` インターフェースは React のためだけのものではありません。codegen がこれを読み、`about/Index` という名前のページが `title` と `description` という 2 つの文字列を受け取ることを記録します。マニフェストを再生成します。

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

まだ緑ですが、今度は望んだ理由で緑です。コントローラーがタイトルを prop として送ったから、本文にタイトルが含まれています。ブラウザで `/about` をリロードすると、まずサーバーでレンダリングされ、それからブラウザ側で React が引き継ぐページが表示されます。試しにコントローラーから `description` を消して `bun run typecheck` を走らせてみてください。エラーはページ名と欠けた prop を名指しします。戻しておきましょう。

この節から持ち帰るものは 3 つです。

- **ページ名はファイルパスです。** `resources/js/pages/about/Index.tsx` が `pages.about.Index` です。ファイルを改名すれば次の codegen で名前も変わり、古い名前を使っていたコントローラーはすべてコンパイルできなくなります。
- **props が契約です。** コントローラーはページが宣言したとおりのものを送ります。形が書かれている場所は他にありません。
- **codegen は覚えておいて実行するビルド手順ではありません。** `bun run dev` が起動時に実行し、ルート、ページ、リソースの変更を監視します。`bunx guren gate` も最初に実行します。ここで手動で走らせたのは、何をするかを見るためです。

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

委ねる前に知っておくべきことがひとつあります。テストランナーの中では、ページは HTML にレンダリングされません。レスポンスが運ぶのはページ名とその props で、`assertBodyContains` はそれを検索します。つまりテストに見えるのは、コントローラーが*送る*ものであって、コンポーネントが*書く*ものではありません。アドレスは prop でなければなりません。これは回避すべき制約ではなく、コンテンツの置き場所をテストが教えてくれているのです。第 1 章のタグラインが prop だった理由でもあります。

## 6. 委ねる

`guren-blog` の中でエージェントに頼みます。

> Add a `/contact` page the way `/about` was built: a `ContactController` with an `index` action that sends `title: 'Contact'` and `email: 'hello@guren-blog.test'` as props, a page at `resources/js/pages/contact/Index.tsx` that shows the title as a heading and the email as a mailto link, and a route named `contact` in `routes/web.ts`. `tests/ContactController.test.ts` already describes it; make it pass.

作業中、この章のハーネス要素を見守ってください。エージェントのコンテキストはすべての rule を常に抱えているわけではありません。`.claude/rules/routes-codegen.md` はこう始まります。

```markdown
---
description: Guren routing & codegen — RouteContractOptions, schema binding, the Zod→ApiRoutes matrix, middleware
globs:
  - "routes/**"
  - "app/Http/Validators/**"
---
```

肝は `globs` の行です。この rule はエージェントが `routes/` 配下のファイルを編集するときに読み込まれ、それまでは読まれません。`controllers-http.md` は `app/Http/**` に対して同じことをします。だからエージェントが `routes/web.ts` を開いた瞬間、`router.get(...)` の正確な形、options オブジェクト、`.name()` が、このバージョンのフレームワークに対して検証済みの状態で、必要なまさにそのときに手渡されます。本物が目の前にあるので、記憶からルート API をでっち上げることはできません。そしてファイルを保存すると `PostToolUse` hook が `guren check` を走らせ、存在しないコントローラーメソッドを指すルートがあれば報告します。

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
- アドレスはコントローラーが送る prop であって、ページにハードコードされた文字列ではない。`resources/js/pages/contact/Index.tsx` は両方の prop を `Props` インターフェースで宣言している。
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
- 頼んだからではなく、開いたファイルが理由で rule がエージェントに届くのを見ました。

## よくあるつまずき

- **`pages.about.Index` が存在しない。** ページを作ってから codegen が走っていません。`bun run codegen` を実行するか、`bun run dev` に任せてください。開発サーバーは、動作中にページが追加されると再生成します。
- **テストは通るのにブラウザは古いページを表示する。** 最後の保存前に開発サーバーがレンダリングし、Inertia が古い props を保持しています。キャッシュを無効にしてリロードするか、`bun run dev` を動かしているターミナルで codegen のエラーを確認してください。
- **エージェントが HTML 入りの `this.text()` を返してきた。** 動きますしテストも通ります。だからこそ rubric は、テストが検査することだけでなく、コントローラーがすべきことを書いています。ページをレンダリングするよう頼み直してください。このコースで何度もやることになる修正です。
- **`guren check` がコントローラーにテストが無いと警告する。** `tests/<Name>Controller.test.ts` を探しています。両方書きましたね。別のコントローラー名が出ているなら、それは第 3 章の仕事です。

## 次へ

[第 3 章: posts テーブル](./03-the-posts-table.md) では、最初のデータベーステーブルとモデル、それを読む 2 つのページを追加し、作成フォームをエージェントに委ねます。
