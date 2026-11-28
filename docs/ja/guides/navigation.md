# ナビゲーション

`defineNavigation()` を使うと、レイアウトに並べるリンクをサーバー側で宣言できます。各エントリーにはルートと、誰に見せるかを書きます。サーバーはページごとに、今のユーザーが見てよいリンクだけを `navigation` という共有 prop でレイアウトに渡すので、レイアウトにロールの判定を書く必要はありません。

## エントリーを宣言する

```ts
// config/navigation.ts
import { defineNavigation } from '@guren/core'
import { Job } from '@/app/Models/Job'

export default defineNavigation([
  { label: 'Jobs', route: 'jobs.index' },
  { label: 'Post a job', route: 'jobs.create', show: { can: ['create', Job] } },
  { label: 'Dashboard', route: 'dashboard', show: { auth: 'required' } },
])
```

この定義は、ほかの config 定義と同じように `createApp()` に渡します（[設定](./configuration.md#config-定義) を参照）。

```ts
// src/app.ts
import navigation from '../config/navigation'

export const app = createApp({
  // ...
  config: [navigation],
})
```

エントリーはただのデータで、ラベル、ルート名、省略できる `show` を持ちます。リンクにはパスのパラメーターを埋める手段がないので、ルートは名前付きの `GET` で、パラメーターを持たないものに限ります。1 つのルートにつきエントリーは 1 つです。

`config/navigation.ts` があると、`guren codegen` はエントリーに使えるルート名を `.guren/routes.gen.ts` に書き出します。そのため、パラメーターを持たない `GET` ルート以外の名前を書くと、型チェックで落ちます。同じ名前が 2 つのルートに付いている場合は、どちらもパラメーターを持たない `GET` ルートのときだけ使えます。codegen を実行するまではどの名前でも型チェックを通るので、そのときは後で説明する起動時の警告で気付くことになります。

codegen はルートファイルを読むので、プロバイダーやプラグインが登録するルートは一覧に入りません。そうしたルートにリンクするときは、アプリの `tsconfig.json` が対象にするファイルのどれかで、その名前をレジストリに足します。

```ts
declare module '@guren/core' {
  interface GurenNavigationRoutes {
    'billing.portal': true
  }
}

export {}
```

逆に、`modules/` にあっても `createApp()` がマウントしていないモジュールのルート名は一覧に入ります。このエントリーは起動時の警告とともに隠され、`guren check` でも報告されます（[エントリーを検査する](#エントリーを検査する)を参照）。

## 誰にエントリーを見せるか

`show` には条件を 3 つまで書けます。書いた条件をすべて満たしたときだけ、エントリーが表示されます。

| 条件 | 表示されるとき |
|---|---|
| `auth: 'required'` | ユーザーがサインインしている |
| `auth: 'guest'` | 誰もサインインしていない |
| `auth: 'any'` | 常に（既定値） |
| `where: { role: 'admin' }` | ユーザーの各フィールドが値と `===` で一致する |
| `can: ['create', Job]` | ゲートがそのモデルのクラスに対する ability を許可する |

`auth` と `where` を先に判定するので、サインインが必要なエントリーのためにゲストの分までゲートに問い合わせることはありません。`where` は厳密に比べます。`teamId` が文字列の `'1'` のユーザーは `{ teamId: 1 }` に一致せず、ゲストはどの `where` にも一致しません。ポリシーを持たないアプリで使う条件です。

`can` は、コントローラーで `this.authorize('create', Job)` を呼んだときと同じく、レコードを渡さずにクラスだけでゲートに問い合わせます（[認可](./authorization.md) を参照）。ゲートは 2 つ目の引数なしでポリシーのメソッドを呼ぶので、ユーザーだけを受け取るメソッドの ability を指定してください。ゲストの場合はユーザーを `null` として問い合わせるので、ユーザーを読むメソッドには `null` への備えが要ります。判定が拒否ならエントリーは隠れます。判定が例外を投げた場合も隠れ、サーバーはそのエラーを ability とモデルの組ごとに 1 回だけログに出します。モデルにポリシーが結び付いておらず、同じ名前のゲートも定義されていない ability は、ゲートが拒否するので、エントリーは誰にも表示されず、ログにも何も出ません。

ability とモデルの組は、ページごとに 1 回ずつ、まとめて同時に問い合わせます。

リンクを隠しても、ページを守ることにはなりません。ユーザーは URL を直接入力できるので、ページを非公開に保つのはルートのミドルウェアと、アクションの `this.authorize()` の役目です。

## コマンドでエントリーを足す

`guren nav:add` を実行すると `config/navigation.ts` にエントリーが足され、`guren nav:remove` を実行するとルート名で指定したエントリーが外れます。

```bash
bunx guren nav:add "Post a job" --route jobs.create --auth required --can create:Job
bunx guren nav:remove jobs.create
```

`--auth` には `required`、`guest`、`any` のどれかを、`--can` には `<ability>:<Model>` の形で指定します。新しいエントリーはリストの最後に入り、インデントとカンマの付け方はファイルに合わせます。`--can` のモデルは `@/app/Models/<Model>` から import されます。`createApp()` は `config/navigation.ts` を import するので、モデルのファイルが無いときや、その名前をクラス以外（型、宣言だけのもの、値）として export しているときに書き込むと、アプリが起動できなくなります。そのため、この場合は書き込まずに止まります。再 export や関数呼び出しで作った値のように、クラスかどうかを確かめられないときは、エントリーを書いたうえで警告します。エントリーを外したときは、ファイルのどこからもモデルの名前が使われなくなった場合に限って、その import も消えます。

どちらのコマンドも `guren check` と同じ読み方でファイルを読むので、スプレッドや翻訳したラベルのように読み戻せない書き方のファイルは編集しません。読み込みから書き込みまでの間はロック（`.guren/locks/navigation.lock`）を取るので、2 つのコマンドを同時に実行してもどちらの編集も残ります。書き込む前には編集結果を読み直し、元のエントリーに 1 つ足した（または 1 つ外した）結果と一致しなければ、何も書きません。ルートそのものの確認は行わないので、`guren check` で確かめてください。`config/navigation.ts` が無いときも止まります。`guren add auth` を実行すると、このファイルがそれを描画するレイアウトと一緒に作られます。

`guren make:feature` と `guren add resource` も同じ書き手を使って、一覧ページのエントリーを足します。ラベルはコレクション名で、`Posts` なら `posts.index` へのリンクになります。`config/navigation.ts` が無いアプリには、エントリーは足されません。モジュールが接頭辞を付けるのはパスだけで、ルート名はそのままなので、モジュールの機能にもエントリーが足されます。

`make:feature` に `--policy` を付けると `can: ['viewAny', Post]` も入り、誰に表示するかは Gate が決めます。ただし一覧のアクション自体は Policy に問い合わせないため、リンクが隠れたユーザーでも URL を直接開けばページを見られます。Policy を登録するまでは Gate が `viewAny` を拒否するので、エントリーは表示されません。ただし `gate.before()` のコールバックや、`viewAny` に定義した Gate が先に答える場合は別です。エントリーはモデルを import し、モデルは `db/schema.ts` からテーブルを import します。スキーマにまだテーブルが無いと、満たせない import のせいでアプリが起動しなくなります。そのため、エントリーはスキーマがテーブルを export してから足され、それまではテーブルを足した後に実行する `nav:add --can` の行が表示されます。モジュールの機能に `--policy` を付けた場合もエントリーは足されません。モジュールのモデルはまだ `can` に使えないためで、`can` の無いエントリーを足す `nav:add` の行が表示されます。

`add resource` がエントリーを足すのは、一覧のルートに名前が付いているときだけです。`routes/web.ts` が既に `/posts` を登録していて、コマンドがそれをそのまま残したときは、代わりに `nav:add` の行が表示されます。同じルートのエントリーが既にあるときは、どちらのコマンドもその旨を表示します。`make:feature --policy` では、そのエントリーに `viewAny` が無いときに警告します。ファイルを読み戻せないときや書けないときも警告します。どの場合も、機能のファイルは書かれます。

`resources/js/components/Layout.tsx` の props がページから渡せる形なら（`guren add auth` が書くレイアウトがそうです）、`make:feature` が書く 4 つのページは `<Layout>` の中に描画され、一覧ページには `wide` が付きます。見るのは default export の関数の props で、`children` と省略できる真偽値の `wide` があり、ほかに必須の props が無いことが条件です。それ以外のレイアウトには手を付けず、ページはそれぞれ自前の `<main>` を持ちます。

## リンクを描画する

`navigation` prop には、ユーザーが見てよいエントリーごとに `label`、`path`、現在のページかどうかを表す `current` だけが入ります。ability の名前、隠れたルート、`where` のフィールドはブラウザーに届きません。現在のエントリーは、パスがリクエストと一致するものです。一致するものがなければ、セグメント単位でリクエストのパスの先頭に当たるもののうち、最も長いものになります。そのため `/jobs/42` では `/jobs` が現在のエントリーになり、`/jobsboard` ではなりません。`/` が現在のエントリーになるのは `/` のときだけです。

```tsx
// resources/js/components/Navigation.tsx
import { Link, usePage } from '@inertiajs/react'
import type { NavigationItem } from '@guren/core'

export function Navigation() {
  const { navigation = [] } = usePage<{ navigation?: NavigationItem[] }>().props
  return (
    <nav>
      {navigation.map((item) => (
        <Link key={item.path} href={item.path} aria-current={item.current ? 'page' : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
```

この prop は lazy です。通常の訪問では解決されますが、`navigation` を求めない部分リロードでは、ゲートへの問い合わせごと飛ばされます。

## `guren add auth` が書くレイアウト

`guren add auth` は `config/navigation.ts` を書き、`createApp()` の `config` 配列に加えます。中身は Home のエントリーと、サインインしたユーザーにだけ見せる Dashboard のエントリーです。Home のエントリーには、パスパラメーターのない `GET` の `home` という名前のルートが要ります。スターターの `/` のルートがこれに当たります。ルートファイルがそのルートを登録していなければ、Dashboard だけを書きます。`config/navigation.ts` が既にあるときは、`--force` を付けても書き換えません。それが `defineNavigation()` の定義なら、`config` 配列への追加だけは行います。

あわせて書くレイアウト `resources/js/components/Layout.tsx` は、`navigation` prop を描画し、現在のエントリーに `aria-current` を付けます。エントリーでは表せないアカウントの操作は、レイアウトに残っています。ゲストには Sign in を、サインインしたユーザーには名前をラベルにした `/profile` へのリンクと、`POST` で送る Log out を出します。これらのラベルは `lang/en/layout.json` から読みます。このファイルは `guren add auth` が一度だけ書き、その後は置き換えません。

ヘッダーの左端のブランドにはアプリの名前が出て、ユーザーに見える最初のエントリーへリンクします。見えるエントリーがなければ `/` へのリンクになります。名前は `app` という共有 prop で、`config/env.ts` が `APP_NAME` を宣言していれば、サーバーがすべてのページに送ります。`createApp({ inertia: { share } })` や `shareInertiaProps()` で独自の `app` prop を共有しているアプリでは、そちらの値が使われます。

ページの幅はページ側で選びます。何も渡さなければフォームに合わせた狭い幅になり、表やボードのページでは `wide` を渡します。

```tsx
import Layout from '../../components/Layout.js'

export default function JobsIndex() {
  return (
    <Layout wide>
      {/* ... */}
    </Layout>
  )
}
```

ヘッダーの幅はどのページでも同じなので、ページを移ってもヘッダーの位置は変わりません。

## 既存のアプリに入れる

navigation モジュールより前に `guren add auth` を実行したアプリには、`config/navigation.ts` も、`navigation` prop を描画するレイアウトもありません。`guren add navigation` を実行すると、この 2 つが入ります。

```bash
bunx guren add navigation
```

`config/navigation.ts` が無ければ、`guren add auth` と同じ Home と Dashboard のエントリーを書き、`createApp()` の `config` 配列に足します。エントリーを書くのは、パラメーターの無い `GET` ルートにその名前（`home`、`dashboard`）が付いているものだけです。`config/navigation.ts` が既にあれば残し、`defineNavigation()` の定義であれば配線だけ行います。

レイアウトを置き換えるのは、`resources/js/components/Layout.tsx` が以前の `guren add auth` が書いた版とバイト単位で同じときだけです（改行コードの違いは無視します）。リリースが出荷したすべての版をハッシュで覚えていて、`guren upgrade` が UI コンポーネントを見分けるのと同じ判定をします。`lang/en/layout.json` が無ければ、あわせて書きます。出荷した版でも、新しいレイアウトがそのアプリで動かない場合は残し、その理由を表示します。

- `config/navigation.ts` が `defineNavigation()` の定義ではないので、リンクを共有するものがない。
- 新しいレイアウトがリンクする `GET /login`、`GET /profile`、`POST /logout` をルートファイルが登録していない（初期のリリースのレイアウトは `/profile` 無しで動いていました）。または、確かめるためのルートファイルを読み込めなかった。
- インストールされている `@guren/inertia-client` に、新しいレイアウトが import する `hasTranslation()` が無い。

インストールされている `@guren/core` に `defineNavigation()` が無いときは、何も書きません。`config/navigation.ts` はアプリの起動時にそれを import するので、先にパッケージを上げてください。手を加えたレイアウトはそのまま残ります。`create-guren-app` がアプリ名を埋め込んで書く blog スターターのレイアウトも残ります。そのうえで、prop を描画するのに要る行を表示します。レイアウトが無いアプリにも、レイアウトを書く代わりに同じ行を表示します。`guren add auth` が書くレイアウトは `/login`、`/profile`、`/logout` へリンクしているためです。

## 起動時に隠れるエントリー

アプリが起動すると、各エントリーがルートに結び付けられます。ルートが登録されていない、`GET` でない、パスのパラメーターを持つ、のどれかに当たるエントリーは隠れ、起動時にエントリーと理由を書いた警告が出ます。ほかのエントリーはそのまま描画されます。存在しないルート名をそのまま使うと、すべてのページが 500 を返してしまうためです。

## エントリーを検査する

`guren check` は `config/navigation.ts` を実行せずに構文として読み、登録されたアプリ（introspection した結果なので、プロバイダーのルートも含みます）と照らしてエントリーを 1 つずつ判定します。結果はすべて参考扱いの警告で、`guren check --ci` と `guren gate` はこれでは落ちません。

| キー | 報告される条件 |
|---|---|
| `navigation-route:<route>` | ルートが登録されていない、`GET` でない、パスのパラメーターを持つ（起動時に隠れる 3 つ）、または同じ名前のルートが 2 つある |
| `navigation-page:<route>` | ルートのアクションが `this.inertia()` を呼ばず、リンク先がページにならない |
| `navigation-sign-in:<route>` | エントリーがゲストにも見えていて（`auth: 'required'`、`where`、`can` のどれもない）、ルートのミドルウェアがサインインを求めている |
| `navigation-ability:<route>` | アクションが、ユーザーだけを受け取るポリシーのメソッドについて、リテラルの ability とモデルのクラスそのものを渡して `this.authorize()` を呼んでいるのに、エントリーの `can` がその ability を書いていない、別の ability を書いている、またはアクションが確かめる 2 つの ability の片方しか書いていない |
| `navigation-can:<route>` | `can` のモデルにポリシーがない、ポリシーにその ability がない（`definePolicy()` でコールバックを渡していない ability は全員を拒否します）、または ability のメソッドが 2 つ目の引数を必須にしている |

検査で読めるように、ファイルはただのデータとして書きます。ラベルとルートは文字列、`where` の値はリテラル、`can` のモデルはそのモデルのファイルから import したクラスにします。spread、計算したキー、翻訳したラベルがあるとファイル全体が読めなくなり、その旨が 1 行で報告されます。インラインのハンドラー、アクションが呼ぶヘルパー、文字列をそのまま書いていない ability、バレル経由で import したモデル、2 つのアプリのルートで同じ名前を持つモデル、先に `before()` が答えうるポリシーは追えないので、通ったことにはせず、確かめられなかったものとして報告します。プロトタイプのルートは、fixture のエントリーを読まずに通します。アプリを introspection できないときはルートをルートファイルから読み、マウントされるかどうか（ゲストに見えるエントリーはサインインの要否も）が分からないエントリーを `navigation-routes-unverified` の 1 行で示します。

モデルのポリシーは `app/Policies/<Model>Policy.ts` のファイルで判断します。`guren audit` と同じ対応づけです。`gate.policy()` で別の名前のポリシーを登録していても読まないので、ファイル名は `make:policy` が書く名前のままにしてください。

## 次に読む

- [認可](./authorization.md): `can` の条件が問い合わせるポリシー
- [Inertia](./inertia.md): 共有 prop と部分リロード
