# アタッチメントガイド

アタッチメントは、アップロードされたファイルをモデルに結び付ける仕組みです。「`Post` は `cover` 画像を 1 つと `images` を複数持つ」とモデルに宣言すると、ファイルは[ストレージディスク](./storage.md)に保存され、1 つの `attachments` テーブルで管理されます。画像のバリデーションと、サムネイル用のバリアント生成も最初から入っています。宣言をモデルに書くので、コレクション名、one/many の種別、バリアント名はどれもコンパイル時に検査されます。

```ts
import { Attachable, defineModel, hasOneAttached, hasManyAttached } from '@guren/core'
import { posts } from '@/db/schema'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({
    image: 'require',
    variants: { thumb: { width: 320 }, og: { width: 1200 } },
  }),
  images: hasManyAttached({ image: 'require' }),
  draftPdf: hasOneAttached(), // 不透明なバイト列。width/height/placeholder は null のまま
}) {}
```

```ts
// コントローラでは1呼び出し:
async store() {
  const data = await this.validateBody(CreatePostSchema)
  const post = await Post.create(data)
  const cover = await this.file('cover')
  if (cover) {
    await Post.attach(post.id, 'cover', cover)
  }
  return this.redirect(`/posts/${post.id}`)
}
```

## セットアップ

> この節の作業は、`bunx guren add attachments` を実行すればすべて自動で済みます。使っているダイアレクトに合わせて `db/schema.ts` にテーブルを追加し、`config/attachments.ts` を書き出し、`AttachmentsProvider` を組み込み、[`attachments:prune`](#孤児の掃除-attachmentsprune) コマンドを登録します(StorageProvider がないアプリには storage ブループリントも導入します)。以下は、同じことを手作業で行う手順です。

### 1. `attachments` テーブルを追加する

テーブルはアプリ側で持ちます(セッションテーブルと同じ考え方です)。使っているダイアレクトのスニペットを `db/schema.ts` に追加し、マイグレーションを実行してください。

**PostgreSQL**(タイムスタンプには `withTimezone: true` が必須で、`guren check` がこれを検査します):

```ts
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(),                       // ULID
  attachableType: text('attachable_type').notNull(), // モデルのクラス名
  attachableId: text('attachable_id').notNull(),     // text なら int / uuid 主キーの両方を扱える
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: jsonb('variants').$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
```

**MySQL:**

```ts
import { index, int, json, mysqlTable, text, timestamp, varchar } from 'drizzle-orm/mysql-core'

export const attachments = mysqlTable('attachments', {
  id: varchar('id', { length: 26 }).primaryKey(),
  attachableType: varchar('attachable_type', { length: 255 }).notNull(),
  attachableId: varchar('attachable_id', { length: 255 }).notNull(),
  collection: varchar('collection', { length: 255 }).notNull().default('default'),
  disk: varchar('disk', { length: 255 }).notNull(),
  path: varchar('path', { length: 1024 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  contentType: varchar('content_type', { length: 255 }).notNull(),
  size: int('size').notNull(),
  width: int('width'),
  height: int('height'),
  variants: json('variants').$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
```

**SQLite:**

```ts
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  attachableType: text('attachable_type').notNull(),
  attachableId: text('attachable_id').notNull(),
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: text('variants', { mode: 'json' }).$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])
```

`variants` カラムは JSON を扱える型にしてください(Postgres は `jsonb`、MySQL は `json`、SQLite は `text(..., { mode: 'json' })`)。`AttachmentVariantRecord` 型は `@guren/core` からインポートします。

### 2. レイヤーを設定する

```ts
// config/attachments.ts
import { configureAttachments } from '@guren/core'
import { attachments } from '@/db/schema'

export const { Attachment, engine: attachmentEngine } = configureAttachments({
  table: attachments,
  storage: (container) => container.make('storage'),
  disk: 'media',            // 新規アタッチメントのデフォルトディスク
})
```

戻り値の `Attachment` は、テーブルに束縛済みで `morphTo('attachable', 'attachable')` も宣言してあるモデルです。morph リレーションや込み入ったクエリに使えます。フレームワーク自体は、あえて `Attachment` クラスをエクスポートしていません。アプリの中で使う名前は、この呼び出しの戻り値から取り出します。

### 3. エンジンをアプリに束縛する

```ts
// app/Providers/AttachmentsProvider.ts
import { ServiceProvider } from '@guren/core'
import { attachmentEngine } from '../../config/attachments'

export default class AttachmentsProvider extends ServiceProvider {
  register(): void {
    attachmentEngine.bindTo(this.container)
  }
}
```

このプロバイダを `createApp({ providers })` に登録します。config モジュールを import すると、起動時に `configureAttachments()` が走ります。これは web プロセスでもワーカープロセスでも、最初の `attach()` より前に実行されます。`bindTo()` は、アプリのコンテナをエンジンに渡します。署名配信ルートはリクエストを受けたアプリのエンジンから配信し、上の `storage` ファクトリにも同じコンテナが渡されます。

束縛がなければ、ルートと storage ファクトリは最後にアタッチメントを設定したアプリを使います。そのため、アプリを 1 つしか動かさないプロセスではこの違いは表に出ず、1 つのプロセスで 2 つのアプリを動かすと違いが出ます。

エンジンは `configureAttachments()` の呼び出しごとに 1 つ作られ、`Application` ごとではありません。同じ config モジュールから作った 2 つのアプリは 1 つのエンジンを共有するので、storage のコンテナは最後に呼んだ `bindTo()` のものになります。アプリごとに分けたい場合は、それぞれに config モジュールを用意してください。

そのほかのオプションは次のとおりです。

| オプション | デフォルト | 用途 |
|---|---|---|
| `disks` | `{}` | ディスクごとの可視性。例: `{ media: 'public', docs: 'private' }`。オブジェクト形式にすると配信モードも指定できます: `{ docs: { visibility: 'private', serve: 'proxy' } }`([URL と可視性](#url-と可視性)参照)。 |
| `delivery` | 無効 | private ディスク向けの署名配信ルートを有効にします: `delivery: {}`(オプション: `prefix`、`routeName`)。ルート登録関数の `registerAttachmentRoutes(router)` と組み合わせて使います。 |
| `maxPixels` | `52_000_000` | デコードするピクセル数の上限(展開爆弾への対策)。 |
| `maxImageBytes` | `50_000_000` | エンコードされた入力のバイト数の上限。デコードの前に検査します。 |
| `processor` | Bun ネイティブ | 独自の `ImageProcessor`。`null` にすると画像のデコードを無効にします。 |
| `queue` | なし | アプリの QueueManager を遅延解決で渡します。指定すると `attach(..., { queued: true })` が使えます。 |
| `urlExpiresIn` | 5分 | private ディスクの URL(署名ルートの URL と `temporaryUrl()` のリンクの両方)の有効期間。URL ごとの上書き: `attachmentUrl(rec, 'cover', { expiresIn })`。 |

### アタッチメント付きフィーチャーのスキャフォールド

レイヤーを導入したあとは、`make:feature`(と `guren add resource`)で
アタッチメントに対応したフィーチャー一式を雛形生成できます。

```bash
bunx guren make:feature Post --fields "title:string,body:text" --attach "cover:one,images:many"
```

`--attach` には、カンマで区切った `name:kind` の組を渡します(kind は `one` か
`many` で、省略すると `one`)。生成されるモデルは `Attachable` ミックスインで
包まれ、どのコレクションにも `image: 'require'` が付きます(画像以外のファイルを
受け取るコレクションでは、このオプションを外してください)。store アクションは
同じ名前の multipart フィールドを `this.file()` / `this.files()` で読んで
`Post.attach()` を呼び、destroy アクションは行を削除する前に
`Post.purgeAttachments()` を呼びます。アプリに `configureAttachments()` が
ないと、このコマンドは雛形を生成しません。先に
`bunx guren add attachments` を実行してください。生成された New ページには、
`<input type="file">` を自分で追加します(Inertia の `useForm` は、フォームデータに
`File` が含まれると自動で multipart の POST に切り替わります)。生成された
`update()` はアタッチメントを扱いません。Edit ページからのアップロードも
受け付けたい場合は、同じ `this.file()` と `Post.attach()` の行を `update()` にも
追加してください(`hasOne` は置き換え、`hasMany` は追加になります)。

## アタッチメントの操作

static メソッドはすべて、宣言に合わせて型付けされています。コレクション名やバリアント名を打ち間違えると、実行時に初めて気づくのではなく、コンパイルエラーになります。

```ts
// バイト列をアタッチ(File、Blob、Uint8Array のみ。パス文字列は不可)
await Post.attach(post.id, 'cover', file)
await Post.attach(post.id, 'images', file, { name: 'photo.jpg', disk: 'archive' })

// hasOne は置き換え(古い行とオブジェクトはパージ)、hasMany は追加。

// デタッチ: コレクション全体、または hasMany の1件
await Post.detach(post.id, 'cover')
await Post.detach(post.id, 'images', attachmentId)

// レコード一覧にアタッチメントをまとめてロード(インデックスの効くクエリ1回)
const withCovers = await Post.withAttachments(posts, ['cover', 'images'])
// → 各レコードに `cover: AttachmentData | null` と `images: AttachmentData[]` が付く

// URL
const url = await Post.attachmentUrl(post, 'cover')
const thumb = await Post.attachmentUrl(post, 'cover', { variant: 'thumb' })

// レコードが所有するすべてを削除(destroy アクションから呼ぶ)
await Post.purgeAttachments(post.id)
```

`AttachmentData` はリソースで返すための形で、`{ id, collection, name, contentType, size, width, height, url, placeholder, variants }` を持ちます。`JsonResource.toArray()` からそのまま返せるので、ページは型の付いたアタッチメントを props として受け取れます。`placeholder` は ThumbHash による LQIP のデータ URL で、実際の画像を読み込んでいる間に表示できます。

`hasOne` の置き換えが同時に起きた場合、1 つのプロセスの中では順番に処理されます。同じテーブルオブジェクトを使う別のエンジンがあっても同様です。複数のプロセスやサーバーレスのインスタンスで動かす場合は、共有のロックサービスを使って `configureAttachments({ withCollectionLock: (key, callback) => sharedLock.run(key, callback), ... })` を設定してください。このロックは、コールバックが終わるまで排他的に保持し、時間のかかるアップロードの間は延長し、失敗したときにも解放しなければなりません。同じアタッチメントテーブルに書き込むすべての箇所で、同じサービスとロックの名前空間を使ってください。

### リレーションで生の行を扱う

テーブルは ORM の morph 規約に沿っているので、行そのものが欲しいときは通常のリレーションの仕組みがそのまま使えます。

```ts
export class Post extends Attachable(defineModel(posts), { /* … */ }) {}
Post.morphMany('attachments', Attachment, 'attachable')

const loaded = await Post.with('attachments').get() // 全コレクションの生の行
```

`morphMany` は、レコードが持つすべてのコレクションを読み込みます。コレクション単位で型付きに扱いたい場合は `withAttachments()` を使います。

## 画像バリデーションとセキュリティ

コレクションで `image: 'require'`(または `'allow'`)を宣言していると、アップロードされたファイルは 3 段階のチェックを順に通ります。

1. **バイト数の上限**: `maxImageBytes` を超える入力は 413 で拒否します。
2. **ヘッダの寸法**: 外部依存のないヘッダパーサ(PNG、JPEG、GIF、WebP、AVIF/HEIC)がヘッダに書かれた寸法を読み、`maxPixels` を超えるものは、デコーダがピクセルバッファを確保する*前に* 422 で拒否します。
3. **フルデコード**: 画像を実際にデコードします。ヘッダの内容と中身が食い違う壊れたファイルや、途中で切れたファイルはここで 422 になります。スニッフィングで判定した content type やクライアントが申告した MIME は記録しますが、画像かどうかの判断には使いません。

1 段目と 2 段目は純粋な JavaScript なので、どのランタイムでも実行されます。3 段目は画像プロセッサがある環境で実行されます(後述)。プロセッサがない場合は、ヘッダの情報をもとにアップロードを受け付け、寸法もヘッダから取ります。

コレクションごとの `image` オプションは次のとおりです。

- 未指定: 中身を解釈しないバイト列として扱います。画像の処理は走らず、`width`/`height`/`placeholder` は `null` のままです(ドキュメントやアーカイブ向け)
- `'allow'`: 画像ならデコードして寸法を測り、それ以外は解釈しないバイト列として保存します
- `'require'`: 画像でないものは 422 の `ValidationException` で拒否します(エラーのキーはコレクション名なので、Inertia のフォームにそのまま表示されます)
- `'forbid'`: スニッフィングで画像と判定されたものを 422 で拒否します

どの環境でも次のルールが守られます。

- **受け付けるのはバイト列だけ。** `attach()` は `File | Blob | Uint8Array` 以外を受け付けません。ファイルシステムのパス文字列を渡せると任意のファイルを読み取れてしまうので、型でも実行時でも拒否します。
- **HEIC/HEIF は既定で 415 を返して拒否します。** HEIC のデコードは OS のコーデックに依存するので、macOS の開発機では動くのに Linux の本番では失敗する、ということがよく起きます。既定の設定でこの差を見逃さないようにしています。`accepts: { heic: 'convert' }` で明示的に有効にすると、デコードして JPEG として保存します。それでも、コーデックがデコードできないランタイムでは 415 を返します。この拒否は、画像の処理が走るときには必ず適用されます。`image: 'allow'` のコレクションも例外ではなく、iPhone で撮った HEIC 写真も `'convert'` を有効にしない限り 415 になります。HEIC のバイト列をそのままファイルとして保存するのは、`image` ポリシーをまったく持たないコレクションだけです。
- **ファイル名はサニタイズされます**(パス区切り文字や制御文字を取り除きます)。ファイル名がオブジェクトキーの一部になるためです。
- **フレームワークが配信する箇所は、ヘッダが強化されています。** 署名配信ルートが proxy で返す応答には、[URL と可視性](#url-と可視性)に挙げた強化用のヘッダがひと通り付きます。public ディスクはこれまでどおり `disk.url()` で、アプリ側のルールに従って配信されます。自分のドメインでユーザーのアップロードを配信するなら、正しい `Content-Type` と `X-Content-Type-Options: nosniff` ヘッダをそのディスク側で付けてください。同じオリジンのページとして表示された SVG は、スクリプトとして動いてしまいます。

## バリアント

コレクションに名前付きのバリアントを宣言しておくと、アタッチしたときに生成されます。

```ts
cover: hasOneAttached({
  image: 'require',
  variants: {
    thumb: { width: 320 },
    og: { width: 1200, height: 630, fit: 'inside', format: 'webp', quality: 80 },
  },
})
```

`fit` は `'fill'` と `'inside'` に対応しています(Bun ネイティブのプロセッサが実際に実装している範囲です。crop モードは、互換性を壊さずに後から追加できます)。

*宣言した*バリアントには、アタッチメントの行にそれぞれステータスが記録されます。値は `ready`、`failed`、`unavailable`(このランタイムにプロセッサがない)、`pending`(キューで生成中、後述)のいずれかです。`attachmentUrl(post, 'cover', { variant: 'thumb' })` は、バリアントが `ready` ならそのバリアントの URL を返し、それ以外なら**オリジナルの URL にフォールバック**します。ページはそのまま描画でき、次に描画したときには自動でバリアントが使われます。宣言していないバリアント名を渡すと、黙ってオリジナルを返すのではなく例外を投げます。

### ランタイムとプロセッサ

既定のプロセッサは Bun ネイティブの `Bun.Image` で、機能の有無を検出して選ばれます。画像のバリアントとフルデコードによる検証には、`Bun.Image` を持つ Bun ランタイムが必要です(Bun 1.4。API 自体は 1.3.14 で入りました)。古い Bun や Bun 以外のランタイム(Node/Lambda、Workers)では、次のようになります。

- アタッチメントの保存と配信は通常どおり動きます
- 宣言したバリアントは `unavailable` として記録され、URL はオリジナルにフォールバックします
- `configureAttachments({ processor })` で、任意の `ImageProcessor` 実装(たとえば sharp を使ったもの)を差し込めます

特定のフォーマット(HEIC、AVIF)をデコード・エンコードできるかどうかは OS のコーデック次第で、実際に呼び出すまで分かりません。デプロイ先のランタイムが扱えないフォーマットには 415 が返るものと考え、アップロードは実際にデプロイするランタイムでテストしてください。

### キュー化された生成

`attach(..., { queued: true })` を使うと、画像の処理をリクエストの処理から切り離せます。リクエストの中では同期的なチェック(バイト数の上限、ヘッダの寸法、HEIC のシグネチャ)だけを行ってオリジナルを保存し、宣言したバリアントをすべて `pending` として記録して、`GenerateVariantsJob` をディスパッチします。そのあとワーカーが、後回しにしたフルデコード、HEIC の変換(有効にしたコレクションのみ)、バリアントの生成を行い、ステータスを `ready`(または `failed`)に更新します。それまでの間、バリアントの URL はオリジナルにフォールバックし、`placeholder` は `null` のままです。

```ts
// config/attachments.ts
export const { Attachment, engine: attachmentEngine } = configureAttachments({
  table: attachments,
  storage: (container) => container.make('storage'),
  disk: 'media',
  queue: () => queueManager,   // アプリの QueueManager を遅延解決で渡す
})

// どこからでも
await Post.attach(post.id, 'cover', file, { queued: true })
```

押さえておきたい点は次のとおりです。

- ジョブは `configureAttachments()` が登録するので、アプリの config を読み込んで起動するワーカープロセス(`bunx guren queue:work`)なら、そのまま処理できます。ワーカーは、画像プロセッサがあるランタイム(`Bun.Image` を持つ Bun、または `configureAttachments({ processor })` で渡した独自の実装)で動かしてください。プロセッサのないワーカーでは、バリアントは `unavailable` で確定します。
- `queue` オプションを指定していない場合、`queued: true` はアプリがすでに起動しているキュードライバを使ってディスパッチします。キュードライバがなければ、何も書き込む前に、原因が分かるエラーを投げます。
- フルデコードがワーカーに移るので、同期的なチェックでは見つけられないもの、つまりヘッダの内容と中身が食い違うバイト列は、受け付けた*あとで*見つかることになります。`image: 'require'` のコレクションではジョブがそのアタッチメントをパージし、それ以外のコレクションでは中身を解釈しないファイルとして残ります。
- Cloudflare Workers では、このモードでなければバリアントを生成できません。[Cloudflare ガイド](./cloudflare.md#workers-でのアタッチメント)を参照してください。

## URL と可視性

可視性はアタッチメントごとではなく、attachments の設定の中で**ディスクごと**に宣言します。R2 のように、可視性がバケットの性質として決まっているドライバに合わせた設計です。

```ts
configureAttachments({
  // …
  disks: { media: 'public', docs: 'private' },
})
```

public ディスクは常に `disk.url(path)` で配信されます。CDN でキャッシュでき、アプリの CPU も使いません。private ディスクには 2 つのモードがあります。

### 署名配信ルート(推奨)

`delivery` を有効にし、ルート登録関数でルートをマウントします。

```ts
// config/attachments.ts
configureAttachments({
  // …
  disks: { media: 'public', docs: 'private' },
  delivery: {},          // オプション: prefix ('/attachments')、routeName ('attachments.show')
})

// routes/web.ts
import { registerAttachmentRoutes } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  registerAttachmentRoutes(router)
  // …アプリのルート…
}
```

すると、private ディスクの `attachmentUrl()` は**パス相対の署名付き URL**(`/attachments/{id}/{filename}?expires=…&signature=…`)を返すようになります。署名にはアタッチメント配信専用に導出した鍵による HMAC を使い、URL は `urlExpiresIn` が過ぎると失効します(URL ごとに上書きするには `{ expiresIn }`、ダウンロードを強制するには `{ disposition: 'attachment' }` を渡します。ただし強制が保証されるのは proxy の応答だけで、リダイレクトするディスクでは、バックエンドが presigned URL の response override に従うかどうかで決まります。R2 は従いません: [Cloudflare ガイド](./cloudflare.md#workers-でのアタッチメント)参照)。ルートはまず署名を検証します(検証に失敗した場合はどれも同じ 404 を返します)。次に、配信のタイミングでバリアントを解決します(宣言済みでまだ生成されていないバリアントにはオリジナルを返し、生成が終わると同じ URL でバリアントを返すようになります)。そのうえで、次のどちらかの方法で配信します。

- ドライバが `capabilities.presignedGet` を宣言しているディスク(S3、`presign` 付きの R2)では、有効期間の短い presigned URL に **302 でリダイレクト**します。バイト列はバケットが配信するので、アプリの帯域は使いません。
- それ以外のディスクでは、強化したヘッダ(inline の allowlist、`nosniff`、`Content-Security-Policy: sandbox`、`Referrer-Policy: no-referrer`、ETag/304)を付けて**プロキシで配信**します。この方法なら、**local ディスクの private が本当に非公開になり**、**R2 の private ディスクも `presign` のクレデンシャルなしにバインディングだけで動きます**。

ディスクごとに上書きしたい場合は、`disks` をオブジェクト形式で書きます: `{ docs: { visibility: 'private', serve: 'proxy' } }`。`serve` に指定できるのは `'auto'`(既定)、`'redirect'`、`'proxy'`、`'direct'`(ルートを使わず、従来どおり `temporaryUrl()` の URL を返す)です。`guren check` は、`delivery` を設定しているときにルートがマウントされているかを確かめ、presign できないドライバのディスクに `serve: 'redirect'` を指定していないかも検出します。

**配信 prefix は 1 プロセスにつき 1 つです。** マウントされるルートの `prefix` と `routeName` には、ルートを登録するアプリの設定ではなく、プロセス内で最後に実行された `configureAttachments()` の設定が使われます。異なる prefix を設定した 2 つの `Application` が同じプロセスにあると、どちらも同じ prefix でマウントされ、どちらの prefix になるかはモジュールの読み込み順で決まります。1 プロセスに 1 アプリという通常のデプロイや、prefix が同じ 2 つのアプリでは、この問題は起きません。

このルートがやらないことも 2 つあります。1 つ目に、これは capability URL で、リクエストごとの認可は行いません(失効前の URL を持っていれば誰でも読めます。アクセスを取り消せるようにしたい場合は、`attachmentUrl()` を自分のコントローラーで包んでください)。2 つ目に、裏側のストア自体が公開されている場合、それを非公開にはできません。local ディスクなら、private ディスクのディレクトリを静的配信している設定も止めてください。公開のマウントを閉じずにルートだけ登録しても、開いたドアに鍵を付けるようなものです。

運用面の注意も 2 つあります。署名はクエリ文字列に載る bearer クレデンシャルなので、アクセスログではこのルートの prefix に付くクエリパラメータを伏せてください(ブラウザの履歴にも残ります。既定の有効期間を日単位ではなく分単位にしている理由の 1 つです)。また、proxy での配信はアプリを通してバイト列を返すので、帯域を気にするアプリでは、通常のルートミドルウェアでこの prefix にレート制限をかけ、リダイレクトできるディスクを優先してください。

### `delivery` 無し(v1 の挙動)

private ディスクは `disk.temporaryUrl(path, expiry)` にフォールバックするので、ドライバ側の制限がそのまま残ります。`LocalDriver.temporaryUrl()` はただの公開 URL を返し(実際には非公開になりません)、R2 では `presign` のクレデンシャルが必要です。`delivery` を有効にすれば、この 2 つの問題はどちらも解消します。

## ライフサイクルと削除

ポリモーフィックな `attachableType`/`attachableId` の組には外部キーを張れないので、**データベースのカスケード削除は使えません**。削除は明示的に行います。

```ts
async destroy() {
  const { id } = this.validateParams(PostIdParamSchema)
  await Post.purgeAttachments(id)   // オブジェクトが先、行が後
  await Post.delete({ id })
  return this.redirect('/posts')
}
```

- `detach`/`purgeAttachments` は、先にストレージのオブジェクトを(アタッチメントごとの prefix 単位で)削除し、そのあとで行を削除します。途中でクラッシュしても、残るのは何も指していない行だけで、次に描画したときにはっきり表に出ます。逆の順序だと、目に見えない孤児オブジェクトが残り、バケットを監査しない限り見つかりません。
- モデルの delete フックは、パージの仕組みとしては*使いません*。フックはビルダー経由の削除(`Post.where(...).delete()`)では発火しない一方、ソフトデリートでも `forceDelete` と同じように発火し、しかも受け取るのは行ではなく where 句です。destroy アクションの中で `purgeAttachments()` を明示的に呼んでください。
- `SoftDeletes` と組み合わせる場合、ソフトデリートではアタッチメントを残します(restore できる必要があるためです)。`forceDelete` する処理の中で `purgeAttachments()` を呼んでください。

### 孤児の掃除: `attachments:prune`

削除は「明示的な削除と、定期的な掃除」の 2 本立てで行います。明示的なパージをすり抜けたもの、たとえば `purgeAttachments()` を呼ばない経路で削除されたレコードの残りや、クラッシュしたジョブや競合したジョブが残したストレージの prefix は、`AttachmentsPruneCommand` が回収します。コンソールカーネルに登録してください。

```ts
// src/console.ts
import { AttachmentsPruneCommand } from '@guren/core'
kernel.register(AttachmentsPruneCommand)
```

```bash
bun run console attachments:prune             # レコードが存在しない行を削除
bun run console attachments:prune --objects   # どの行からも参照されない attachments/ プレフィックスも削除
bun run console attachments:prune --dry-run   # 削除せずに報告のみ
```

孤児になった行は、各 `attachableType` を `Model.morphMap` で解決し、持ち主のレコードがあるかを問い合わせて見つけます。そのため、アタッチメントを宣言しているモデルはすべて登録してください。

```ts
Model.morphMap = { Post, User }
```

掃除のコマンドは、孤児だと確かめられたものだけを削除します。morph map にない型、存在確認のクエリが失敗したもの、一覧を取れないディスクは、報告するだけで手を付けません。障害が起きたときに大量削除につながらないようにするためです。スケジュールしたジョブや CI から、アプリに合った頻度で実行してください。

### 生成される型: `.guren/attachments.gen.ts`

モデル自体は mixin のジェネリクスで型付けされますが、ページ・リソース・アップロード用のクライアントからは `typeof Post.attachments` が見えません。そこで `guren codegen` が各モデルの `Attachable(...)` 宣言を読み取り、それらの境界をまたいで使えるマップを生成します(Vite プラグインは、`app/Models/` の下やモジュールの同じディレクトリでファイルが変わるたびに生成し直します)。

```ts
// .guren/attachments.gen.ts — 生成物のため編集不可
export interface AttachmentsMap {
  Post: { cover: 'one'; images: 'many' }
}
export interface AttachmentVariantsMap {
  Post: { cover: 'og' | 'thumb'; images: never }
}
export type AttachableModelName = keyof AttachmentsMap
export type AttachmentName<M extends keyof AttachmentsMap> = keyof AttachmentsMap[M]
```

`Attachable` モデルがないアプリでは、ファイルは生成されません。ジェネレータは宣言を静的に読むので、最後まで解析できない宣言(スプレッドや、別の場所で組み立てたオプションオブジェクト)は、中途半端に出力せずに警告を出して飛ばします。マップに含めたいモデルの宣言は、インラインのオブジェクトリテラルで書いてください。

### エージェントコマンドが検証すること

- `bunx guren check` は、`configureAttachments()` に渡したテーブルが `db/schema.ts` から実際にエクスポートされているかを検証します。レイヤーはテーブルを型なしで受け取るので、このチェックがないと、スキーマのエクスポート名を変えたことに最初の attach で実行時エラーが出るまで気づけません。
- `bunx guren check` は、アプリに `configureAttachments()` の呼び出しが 1 つもないのに `Attachable(...)` を mixin しているモデルも検出します。mixin はレイヤーを最初に使うときに解決するので、これも本来は実行時まで設定漏れに気づけません。
- `bunx guren audit` は、型付きの `attach()` に渡されたアップロードを検証済みとして扱います(宣言に基づく画像のチェックそのものが検証だからです)。それ以外のボディ入力を読むアクションには、これまでどおりルートの `body` スキーマか `validateBody()` が必要です。

## テスト

`memory` ストレージドライバを使い、テスト用データベースに対して設定します。

```ts
import { configureAttachments, StorageManager } from '@guren/core'
import { attachments } from '@/db/schema'

const storage = new StorageManager({
  default: 'media',
  disks: { media: { driver: 'memory', url: 'https://cdn.test' } },
})

configureAttachments({ table: attachments, storage: () => storage, disk: 'media' })

const record = await Post.attach(post.id, 'cover', new File([bytes], 'cover.png'))
expect(await storage.disk('media').exists(record.path)).toBe(true)
```

Vitest の `jsdom` 環境では、`createControllerContext()` からアップロードした `File` がコントローラーのアクションに届きません。jsdom 独自の `File` と `Blob` が、undici が multipart ボディの組み立てと解析に使うクラスとは別物だからです。Vitest と Node のバージョンによって、テストがタイムアウトする、undici の内部で失敗する、`this.file()` が `null` を返しているのにテストが通る、のどれかになります。こうしたテストファイルは、1 行目に次のコメントを書いて Node 環境で実行してください。

```ts
// @vitest-environment node
```
