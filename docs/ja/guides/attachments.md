# アタッチメントガイド

アタッチメントは、アップロードされたファイルをモデルに結び付けます。「`Post` は `cover` 画像を1つと `images` を複数持つ」という宣言をモデルに書くと、ファイルは[ストレージディスク](./storage.md)に保存され、1つの `attachments` テーブルで追跡され、画像バリデーションとサムネイル用のバリアント生成が組み込みで付いてきます。宣言はモデル上にあるため、コレクション名、one/many の種別、バリアント名はすべてコンパイル時に検査されます。

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

### 1. `attachments` テーブルを追加する

テーブルはアプリが所有します(セッションテーブルと同じ流儀です)。使用するダイアレクトのスニペットを `db/schema.ts` に追加し、マイグレーションを実行してください。

**PostgreSQL**(タイムスタンプには `withTimezone: true` が必須です。`guren check` が検査します):

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

`variants` カラムは JSON を扱える型にしてください(Postgres は `jsonb`、MySQL は `json`、SQLite は `text(..., { mode: 'json' })`)。`AttachmentVariantRecord` 型は `@guren/core` からインポートできます。

### 2. レイヤーを設定する

```ts
// config/attachments.ts
import { configureAttachments } from '@guren/core'
import { attachments } from '@/db/schema'
import { storage } from './storage'

export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => storage,   // アプリの StorageManager を遅延解決で渡す
  disk: 'media',            // 新規アタッチメントのデフォルトディスク
})
```

このモジュールを起動時に一度インポートしてください(たとえば `src/app.ts` から、他の config と同じように)。戻り値の `Attachment` はテーブルに束縛された既製のモデルで、`morphTo('attachable', 'attachable')` が宣言済みです。morph リレーションや高度なクエリに使えます。フレームワーク自身は意図的に `Attachment` クラスをエクスポートしません。アプリローカルの名前はこの呼び出しから得ます。

その他のオプション:

| オプション | デフォルト | 用途 |
|---|---|---|
| `disks` | `{}` | ディスクごとの可視性。例: `{ media: 'public', docs: 'private' }`。private のディスクは `temporaryUrl()` で URL を発行します。 |
| `maxPixels` | `52_000_000` | デコード時のピクセル数上限(展開爆弾対策)。 |
| `maxImageBytes` | `50_000_000` | デコード前に検査するエンコード済み入力のバイト数上限。 |
| `processor` | Bun ネイティブ | カスタム `ImageProcessor`。`null` で画像デコードを無効化。 |
| `queue` | なし | アプリの QueueManager を遅延解決で渡す。`attach(..., { queued: true })` を有効化。 |
| `urlExpiresIn` | 5分 | private ディスクの `temporaryUrl()` リンクの有効期間。 |

## アタッチメントの操作

すべての static メソッドは宣言に対して型付けされます。コレクション名やバリアント名の打ち間違いは実行時の事故ではなくコンパイルエラーになります。

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

`AttachmentData` はリソース向けの形です: `{ id, collection, name, contentType, size, width, height, url, placeholder, variants }`。`JsonResource.toArray()` からそのまま返せるので、ページは型の付いたアタッチメント props を受け取れます。`placeholder` は ThumbHash の LQIP データ URL で、実画像のロード中に表示できます。

### リレーションで生の行を扱う

テーブルは ORM の morph 規約に従っているため、行そのものが欲しいときは通常のリレーション機構がそのまま使えます:

```ts
export class Post extends Attachable(defineModel(posts), { /* … */ }) {}
Post.morphMany('attachments', Attachment, 'attachable')

const loaded = await Post.with('attachments').get() // 全コレクションの生の行
```

`morphMany` はレコードの全コレクションをロードします。コレクション単位の型付きの経路は `withAttachments()` です。

## 画像バリデーションとセキュリティ

コレクションが `image: 'require'`(または `'allow'`)を宣言していると、アップロードは3段ゲートのパイプラインを通ります:

1. **バイト数上限**: `maxImageBytes` を超える入力は 413 で拒否します。
2. **ヘッダ寸法**: 依存ゼロのヘッダパーサ(PNG、JPEG、GIF、WebP、AVIF/HEIC)が宣言済みの寸法を読み、`maxPixels` を超えるものはデコーダがピクセルバッファを確保する*前に* 422 で拒否します。
3. **フルデコード**: 画像を実際にデコードします。ヘッダで嘘をつく破損ファイルや途中で切れたファイルはここで 422 になります。スニフした content type やクライアント申告の MIME は記録されますが、画像かどうかの判定には決して使われません。

ゲート1と2は純粋な JavaScript で、どのランタイムでも実行されます。ゲート3は画像プロセッサが存在する環境で実行されます(後述)。プロセッサがない場合、アップロードはヘッダの証拠に基づいて受理され、寸法もヘッダ由来になります。

コレクションごとの `image` オプション:

- 未指定: 不透明なバイト列。画像パイプラインは走らず、`width`/`height`/`placeholder` は `null` のまま(ドキュメントやアーカイブ向け)
- `'allow'`: 画像ならデコードして採寸し、それ以外は不透明なバイト列として保存
- `'require'`: 画像でないものは 422 の `ValidationException` で拒否(エラーはコレクション名をキーにするので、Inertia のフォームにそのまま表示されます)
- `'forbid'`: 画像としてスニフされたものを 422 で拒否

どの環境でも守られるルール:

- **バイト列のみ。** `attach()` が受け付けるのは `File | Blob | Uint8Array` だけです。ファイルシステムのパス文字列は任意ファイル読み取りの入口になるため、型でも実行時でも拒否されます。
- **HEIC/HEIF はデフォルトで 415 拒否。** HEIC のデコードは OS コーデック依存で、macOS の開発機では動き Linux の本番では失敗する、というずれを既定で見逃すわけにはいきません。`accepts: { heic: 'convert' }` でオプトインすると、デコードして JPEG として保存します。コーデックがデコードできないランタイムではやはり 415 を返します。この拒否は画像パイプラインが走るとき常に適用されます。`image: 'allow'` のコレクションも対象で、iPhone の HEIC 写真は `'convert'` にオプトインしない限り 415 になります。HEIC のバイト列を不透明ファイルとして保存するのは、`image` ポリシーを持たないコレクションだけです。
- **ファイル名はサニタイズされます**(パス区切りや制御文字の除去)。オブジェクトキーの一部になるためです。
- **配信はアプリの既存ルールに従います。** アタッチメントは配信ルートを追加しません。public ディスクは `disk.url()`、private ディスクは `disk.temporaryUrl()` で配信します。ユーザーのアップロードを自分のドメインで配信するディスクでは、正しい `Content-Type` と `X-Content-Type-Options: nosniff` ヘッダを必ず付けてください。インライン表示される SVG はスクリプトになりえます。

## バリアント

コレクションに名前付きバリアントを宣言すると、アタッチ時に生成されます:

```ts
cover: hasOneAttached({
  image: 'require',
  variants: {
    thumb: { width: 320 },
    og: { width: 1200, height: 630, fit: 'inside', format: 'webp', quality: 80 },
  },
})
```

`fit` は `'fill'` と `'inside'` に対応します(Bun ネイティブのプロセッサが実際に実装している範囲です。crop モードは互換性を壊さずに追加できます)。

*宣言済み*のバリアントはすべて、アタッチメント行にステータスエントリを持ちます: `ready`、`failed`、`unavailable`(このランタイムにプロセッサがない)、`pending`(キュー化生成、後述)。`attachmentUrl(post, 'cover', { variant: 'thumb' })` は `ready` のバリアントならそのバリアント自身の URL を返し、それ以外は**オリジナルの URL にフォールバック**します。ページは描画され続け、後の描画が自動的にバリアントを拾います。宣言されていないバリアント名は、黙ってオリジナルを返すのではなく throw します。

### ランタイムとプロセッサ

デフォルトのプロセッサは Bun ネイティブ(`Bun.Image`)で、フィーチャーディテクションで解決されます。画像バリアントとフルデコード検証には `Bun.Image` を持つ Bun ランタイムが必要です(Bun 1.4。API 自体は 1.3.14 から)。古い Bun や Bun 以外のランタイム(Node/Lambda、Workers)では:

- アタッチメントの保存と配信は通常どおり動きます
- 宣言済みバリアントは `unavailable` として記録され、URL はオリジナルにフォールバックします
- `configureAttachments({ processor })` で任意の `ImageProcessor` 実装(たとえば sharp ベース)を注入できます

特定フォーマット(HEIC、AVIF)のデコード/エンコード可否は OS コーデックの性質で、呼び出し時に判明します。デプロイ先のランタイムが扱えないフォーマットには 415 が返ることを想定し、アップロードは実際にデプロイするランタイムでテストしてください。

### キュー化された生成

`attach(..., { queued: true })` は画像処理をリクエストパスから外します。リクエストは同期ゲート(バイト数上限、ヘッダ寸法、HEIC シグネチャ)だけを実行してオリジナルを保存し、宣言済みバリアントをすべて `pending` として記録し、`GenerateVariantsJob` をディスパッチします。その後ワーカーが、先送りされたフルデコード、オプトイン済みコレクションの HEIC 変換、バリアント生成を行い、ステータスを `ready`(または `failed`)へ更新します。それまでの間、バリアント URL はオリジナルへフォールバックし、`placeholder` は `null` のままです。

```ts
// config/attachments.ts
export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => storage,
  disk: 'media',
  queue: () => queueManager,   // アプリの QueueManager を遅延解決で渡す
})

// どこからでも
await Post.attach(post.id, 'cover', file, { queued: true })
```

押さえておくこと:

- `configureAttachments()` がジョブを登録するため、アプリの config を起動するワーカープロセス(`bunx guren queue:work`)はそのまま処理できます。ワーカーは画像プロセッサのあるランタイム(`Bun.Image` を持つ Bun、または `configureAttachments({ processor })` のカスタム実装)で動かしてください。プロセッサのないワーカーはバリアントを `unavailable` として確定させます。
- `queue` オプションなしの場合、`queued: true` はアプリが起動済みのキュードライバ経由でディスパッチします。何もなければ、書き込みを行う前に明確なエラーを投げます。
- フルデコードはワーカーへ移るため、同期ゲートが捕まえられない唯一のクラス、つまりヘッダで嘘をつくバイト列は受理*後*に検出されます: `image: 'require'` コレクションではジョブがアタッチメントをパージし、それ以外のコレクションでは不透明ファイルとして残ります。
- Cloudflare Workers ではこれがバリアントを生成する唯一のモードです。[Cloudflare ガイド](./cloudflare.md#workers-でのアタッチメント)を参照してください。

## URL と可視性

可視性はアタッチメント単位ではなく、attachments 設定の中で**ディスク単位**に宣言します。R2 のように可視性がバケットの性質であるドライバに合わせた設計です:

```ts
configureAttachments({
  // …
  disks: { media: 'public', docs: 'private' },
})
```

- public ディスク: `attachmentUrl()` は `disk.url(path)` を返します。CDN にキャッシュでき、アプリの CPU を使いません。
- private ディスク: `attachmentUrl()` は `disk.temporaryUrl(path, expiry)` を返します。

ドライバから引き継ぐ既知の制限が2つあります:

- `LocalDriver.temporaryUrl()` はただの公開 URL を返すため、「local ディスク上の private」は**実際には private ではありません**。
- `R2Driver` は `presign` クレデンシャルが設定されているときだけ署名できます。未設定だと `temporaryUrl()` は throw するため、R2 上の private アタッチメントには `presign` オプションが必要です。

## ライフサイクルと削除

ポリモーフィックな `attachableType`/`attachableId` の組には外部キーを張れないため、**データベースのカスケード削除はできません**。削除は明示的に行います:

```ts
async destroy() {
  const { id } = this.validateParams(PostIdParamSchema)
  await Post.purgeAttachments(id)   // オブジェクトが先、行が後
  await Post.delete({ id })
  return this.redirect('/posts')
}
```

- `detach`/`purgeAttachments` はストレージオブジェクトを先に(アタッチメントごとのプレフィックスで)削除し、その後に行を削除します。途中でクラッシュしても残るのは「何も指していない行」で、次の描画が大きな音を立てて教えてくれます。逆順だと、バケット監査でしか見つからない不可視の孤児オブジェクトが残ります。
- モデルの delete フックはパージの仕組みとして*使いません*。フックは一部の削除経路でしか発火せず、受け取るのも行ではなく where 句です。destroy アクションで `purgeAttachments()` を明示的に呼んでください。
- `SoftDeletes` と併用する場合、ソフトデリートはアタッチメントをそのまま残します(restore が機能する必要があるため)。`forceDelete` の経路で `purgeAttachments()` を呼んでください。

## テスト

`memory` ストレージドライバを使い、テスト用データベースに対して設定します:

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
