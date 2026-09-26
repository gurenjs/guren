# 第 2 章: リクエストを 1 つ手で組む

第 1 章で作ったアプリには、自分で書いていないページが 1 つだけありました。この章では、次のページを空のファイルから書いていきます。書く順序は、このコースでこの先ずっと使うもので、失敗するテスト、ルート、コントローラー、ページの順です。そのあと 2 つ目のページのテストを先に書いてエージェントに任せ、編集中のファイルに合ったルールをハーネスが読み込ませる動きを確認します。

**この章で学ぶこと:**

- リクエストが `routes/web.ts` からコントローラーのメソッドを通って `Response` になるまでの流れ
- 素の Response と Inertia ページの違いと、それぞれが適している場面
- `bun run codegen` がページの `Props` から生成するものと、`pages.about.Index` がコンパイル時に検査される名前になっている理由
- ルートに名前を付け、型付きの `route()` ヘルパーでリンクする方法
- ハーネスの glob で対象を絞ったルールが、そのファイルを編集するときにだけエージェントに届く仕組み

開発サーバーを止めている場合は起動し、専用のターミナルで動かしたままにしておいてください。

```bash run background
bun run dev
```

## 1. まずテストを書く

ページはまだありません。まず、ページが何をするべきかをテストに書きます。

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

新しいテストは 404 で失敗します。`/about` に応答するものがまだ無いからです。第 1 章の 3 件は通ったままです。ここから 1 層ずつ書き足して、新しいテストを通していきます。

## 2. ルート

ルートは、HTTP メソッドとパスをコントローラーのアクションに対応付けます。`routes/web.ts` を置き換えます。

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

新しい点は 2 つあります。1 つ目は `[AboutController, 'index']` で、ハンドラー関数ではなくクラスとメソッドを指定しています。Guren はリクエストごとにコントローラーのインスタンスを作るので、メソッドの中では `this` を通してリクエストを読めます。2 つ目は `.name('about')` で、ルートに名前を付けています。URL は変わることがありますが、ページからリンクするときは名前を使います。

もう一度テストを実行すると、今度は別の理由で失敗します。`AboutController` の import が解決できず、アプリが起動しないためです。これは `guren check` でも見つかる種類の問題ですが、今回はテストが先に見つけました。`bun run dev` を動かしているターミナルにも同じエラーが出ています。`routes/web.ts` を保存したことでリロードが走ったものの、コントローラーを import できなかったので、サーバーはそれまでのルートのまま動き続けています。

## 3. まずは素の Response を返すコントローラー

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

テストが通りました。コントローラーのアクションは `Response` を返すメソッドで、`this.text()` は素の Response を組み立てます。コントローラーの決まりはこれだけです。ページを使わない形を一度見ておくと、全体がつかみやすくなります。コントローラーのほかの機能(`this.inertia()`、`this.json()`、`this.redirect()`、第 4 章で扱うバリデーター)も、同じ `Response` を別のやり方で組み立てているだけだからです。

テストは毎回アプリを新しく起動しますが、開発サーバーは違います。リロードに失敗する前のルートを持ったままで、コントローラーを作っても読み込み直しはしません。ターミナルで Ctrl-C を押して止め、もう一度起動してください。

```bash run stop-background
# Ctrl-C in the terminal running bun run dev
```

```bash run background
bun run dev
```

[http://localhost:3333/about](http://localhost:3333/about) を開いてください。予告どおり、プレーンテキストが表示されます。

## 4. ページを作る

素の Response は、ヘルスチェックや webhook には向いています。一方、ページには HTML が必要で、Guren では Inertia ページがその役割を担います。Inertia ページは `resources/js/pages/` の下に置く React コンポーネントで、props をコントローラーから受け取ります。ページを作りましょう。

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

コンポーネントの `Props` インターフェースは、React のためだけにあるわけではありません。codegen がこれを読み取り、`about/Index` というページが `title` と `description` の 2 つの文字列を受け取ることを記録します。マニフェストを再生成します。

```bash run
bun run codegen
```

これで `.guren/pages.gen.ts` に `pages.about.Index` ができ、`this.inertia()` は形の合わない props を受け付けなくなります。コントローラーがこのページを返すように書き換えます。

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

テストはまだ通っていますが、今度は意図したとおりの理由で通っています。コントローラーがタイトルを prop として送ったので、レスポンスの本文にタイトルが含まれます。ブラウザで `/about` をリロードすると、まずサーバーでレンダリングされたページが表示され、そのあとブラウザ側で React が処理を引き継ぎます。試しにコントローラーから `description` を消して、`bun run typecheck` を実行してみてください。渡した props に `description` が足りないというエラーが出ます。確認したら元に戻しておきましょう。

この節で押さえておきたいことは 3 つです。

- **ページ名はファイルパスです。** `resources/js/pages/about/Index.tsx` は `pages.about.Index` になります。ファイル名を変えると次の codegen で名前も変わり、古い名前を使っていたコントローラーはすべてコンパイルエラーになります。
- **props が契約です。** コントローラーは、ページが宣言したとおりの props を送ります。props の形を書く場所はほかにありません。
- **codegen は手で覚えて実行するビルド手順ではありません。** `bun run dev` が起動時に実行し、そのあともルート、ページ、リソースの変更を監視して実行します。`bunx guren gate` も最初に codegen を実行します。ここで手で実行したのは、何をしているかを確かめるためです。

変更全体を確かめて、コミットします。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the about page"
```

## 5. contact ページのテストを先に書く

同じ作り方で contact ページも作ります。今回はテストだけを書きます。

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

テストは失敗します。このテストが仕様です。誰がページを作るにしても、このテストが通れば完成です。

エージェントに任せる前に、知っておいてほしいことが 1 つあります。テストランナーの中では、ページは HTML にレンダリングされません。レスポンスに入っているのはページ名と props で、`assertBodyContains` もその中を検索します。つまりテストで確かめられるのはコントローラーが*送る*内容だけで、コンポーネントの中に*書かれた*だけの内容は見えません。そのため、メールアドレスは prop にする必要があります。これは回避すべき制約というより、コンテンツをどこに置くべきかをテストが教えてくれていると考えてください。第 1 章のタグラインを prop にしたのも同じ理由です。

## 6. エージェントに任せる

`guren-blog` の中で、エージェントに次のプロンプトを送ります。

```text
Add a `/contact` page the way `/about` was built: a `ContactController` with an `index` action that sends `title: 'Contact'` and `email: 'hello@guren-blog.test'` as props, a page at `resources/js/pages/contact/Index.tsx` that shows the title as a heading and the email as a mailto link, and a route named `contact` in `routes/web.ts`. `tests/ContactController.test.ts` already describes it; make it pass.
```

エージェントが作業している間は、この章で扱うハーネスの仕組みにも注目してください。エージェントのコンテキストには、すべてのルールが常に読み込まれているわけではありません。`.claude/rules/routes-codegen.md` の冒頭は次のようになっています。

```markdown
---
paths:
  - "routes/**"
  - "app/Http/Validators/**"
  - "modules/*/routes.ts"
  - "modules/*/routes/**"
  - "modules/*/app/Http/Validators/**"
---
```

要点は `paths` のリストです。このルールは、エージェントが `routes/` の下(またはモジュールのルート)のファイルを扱うときに初めて読み込まれます。`controllers-http.md` も同じ仕組みで、`app/Http/**` を対象にしています。そのため、エージェントが `routes/web.ts` を開いた時点で、`router.get(...)` の正確な書き方、options オブジェクト、`.name()` の使い方が、このバージョンのフレームワークで検証済みの内容として、必要なときに渡されます。正しい定義が目の前にあるので、エージェントが記憶を頼りにルートの API をでっち上げることもありません。さらに、ファイルを保存すると `PostToolUse` hook が `guren check` を実行し、存在しないコントローラーメソッドを指すルートがあれば報告します。

**手元にエージェントが無い場合は、** 次の 3 ファイルを書きます。(エージェントは `bunx guren make:controller Contact` から始めるかもしれません。このコマンドは、`pages.contact.Index` をレンダリングするところまで書かれたコントローラーの骨組みを生成します。こうしてジェネレーターを使う習慣については、第 3 章で扱います。)

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

どちらの方法でも、マニフェストを再生成してから仕様のテストを実行します。

```bash run
bun run codegen
```

```bash run
bun test
```

受け入れる前にレビューします。確認項目は次のとおりです。

- `routes/web.ts` への追加は、`contact` という名前の `GET /contact` ルート 1 行と、その import だけ。ほかの行は変わっていない。
- `ContactController` のアクションは 1 つで、ページをレンダリングしている。HTML を手で組み立てたり、`this.text()` を返したりしていない。
- メールアドレスはコントローラーが送る prop になっていて、ページに直接書かれていない。`resources/js/pages/contact/Index.tsx` は、2 つの prop を両方とも `Props` インターフェースで宣言している。
- `tests/ContactController.test.ts` は変更されておらず、このテストもほかのテストもすべて通る。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the contact page"
```

## ここまでの状態

- 1 つのリクエストをすべての層でたどり、各層を手で書きました。
- codegen がページから何を導出するかと、ページ名と props がコンパイル時に検査されることを学びました。
- まだないページのテストを先に書いてエージェントに任せ、確認項目に照らして受け入れました。
- ルールは頼まなくても、開いたファイルに応じてエージェントへ届くことを確認しました。

## よくあるつまずき

- **`pages.about.Index` が存在しない。** ページを作ったあとに codegen が実行されていません。`bun run codegen` を実行するか、`bun run dev` に任せてください。開発サーバーは、動いている間にページが追加されると再生成します。
- **コントローラーを作ったのに、ブラウザでは `/about` が 404 のまま。** 3 節のあとで `bun run dev` を再起動していません。`AboutController.ts` より先に `routes/web.ts` を保存すると、そのときのリロードは存在しない import のせいで失敗し、古いルートが残ります。あとからファイルを作っても、ルートは登録されません。`bun run dev` を再起動してください。
- **テストは通るのにブラウザは古いページを表示する。** 最後に保存する前に開発サーバーがレンダリングしていて、Inertia が古い props を持ったままになっています。キャッシュを無効にしてリロードするか、`bun run dev` を動かしているターミナルに codegen のエラーが出ていないか確認してください。それでも直らなければ、`bun run dev` を再起動してください。
- **エージェントが HTML 入りの `this.text()` を返してきた。** これでも動き、テストも通ります。そのため確認項目には、テストが検査する内容だけでなく、コントローラーのあるべき形も書いてあります。ページをレンダリングするよう頼み直してください。このコースでは、この直し方を何度も使います。
- **`guren check` がコントローラーにテストが無いと警告する。** `tests/<Name>Controller.test.ts` というファイルを探しています。この章の 2 つのコントローラーにはどちらもテストを書いたので、警告に別のコントローラー名が出ているなら、それは第 3 章で扱う問題です。

## 演習

1. `/health` はコントローラーを使わないインラインのハンドラーです。ブランチを切って、現在時刻を返すインラインのルートをもう 1 本追加してください。そのうえで、コントローラーのアクションではなくこの書き方を選ぶと何を失うかを答えてください。
2. `this.inertia(pages.about.Index, …)` は、ページを文字列ではなく生成されたコードから受け取ります。存在しないページ名に書き換えて、TypeScript のエラーを読んでください。このエラーを出せることが、`pages.*` を使う理由のすべてです。読んだら元に戻してください。

## 次へ

[第 3 章: posts テーブル](./03-the-posts-table.md) では、最初のデータベーステーブルとモデル、そのテーブルを読む 2 つのページを追加し、作成フォームをエージェントに任せます。
