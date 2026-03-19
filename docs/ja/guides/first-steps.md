# はじめの一歩: Hello Guren

Guren を触り始める最短の手順です。DB は使わず、`/hello` にアクセスするとメッセージが表示されるページを作ります。

## このガイドでやること
- ルート → コントローラ → React ページの最小構成を作る
- 実際にブラウザで表示を確認する

## 前提
- `bunx create-guren-app` で作成済みのプロジェクト
- `bun install` 済み
- `bun run dev` が起動できる

> [!NOTE]
> 用語が分からない場合は [用語集](./glossary.md) を参照してください。このガイドではデータベースを使いません。PostgreSQL が起動していなくても進められます。

## 完成イメージ
- `http://localhost:3333/hello` にアクセスすると `Hello Guren!` が表示される

## 1. コントローラを作成
`app/Http/Controllers/HelloController.ts` を作成します。

```ts
import { Controller } from '@guren/server'

export default class HelloController extends Controller {
  async index() {
    return this.inertia('Hello', { message: 'Hello Guren!' })
  }
}
```

## 2. ページを作成
`resources/js/pages/Hello.tsx` を作成します。

```tsx
type Props = {
  message: string
}

export default function Hello({ message }: Props) {
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <h1 className="text-3xl font-semibold">{message}</h1>
      <p className="mt-3 text-slate-600">
        これは Guren の最小構成ページです。
      </p>
    </main>
  )
}
```

## 3. ルートを登録
`routes/web.ts` にルートを追加します。

```ts
import HelloController from '@/app/Http/Controllers/HelloController'

Route.get('/hello', [HelloController, 'index'])
```

> [!NOTE]
> 通常は `src/main.ts` が `routes/web.ts` を読み込んでいます。自前構成のアプリでは、ルートファイルの import を忘れないでください。

## 4. ブラウザで確認
開発サーバーを起動して確認します。

```bash
bun run dev
```

`http://localhost:3333/hello` を開き、`Hello Guren!` が表示されたら成功です。

## つまずいたら
- 404 が出る: `routes/web.ts` が `src/main.ts` から import されているか確認
- 変更が反映されない: `bun run dev` を再起動
- ポート競合: `.env` の `PORT` を変更して再起動

## 次に読む
1. [Routing](./routing.md)
2. [Controllers](./controllers.md)
3. [Frontend](./frontend.md)
4. [Database](./database.md)
