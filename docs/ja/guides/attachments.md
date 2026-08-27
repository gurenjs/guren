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

> `bunx guren add attachments` を実行すると、このセクション全体を自動で行います: ダイアレクトに合わせて `db/schema.ts` にテーブルを追加し、`config/attachments.ts` を書き、`AttachmentsProvider` を配線し、[`attachments:prune`](#孤児の掃除-attachmentsprune) コマンドを登録します(StorageProvider がないアプリには storage ブループリントも導入します)。以下は同じ内容を手動で行う手順です。

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
| `disks` | `{}` | ディスクごとの可視性。例: `{ media: 'public', docs: 'private' }`。オブジェクト形式で配信モードも指定できます: `{ docs: { visibility: 'private', serve: 'proxy' } }`([URL と可視性](#url-と可視性)参照)。 |
| `delivery` | 無効 | private ディスク向けの署名配信ルートを有効化: `delivery: {}`(オプション: `prefix`、`routeName`)。ルート登録関数での `registerAttachmentRoutes(router)` と対で使います。 |
| `maxPixels` | `52_000_000` | デコード時のピクセル数上限(展開爆弾対策)。 |
| `maxImageBytes` | `50_000_000` | デコード前に検査するエンコード済み入力のバイト数上限。 |
| `processor` | Bun ネイティブ | カスタム `ImageProcessor`。`null` で画像デコードを無効化。 |
| `queue` | なし | アプリの QueueManager を遅延解決で渡す。`attach(..., { queued: true })` を有効化。 |
| `urlExpiresIn` | 5分 | private ディスク URL(署名ルート URL と `temporaryUrl()` リンクの両方)の有効期間。URL 単位の上書き: `attachmentUrl(rec, 'cover', { expiresIn })`。 |

### アタッチメント付きフィーチャーのスキャフォールド

レイヤーの導入後は、`make:feature`（および `guren add resource`）で
アタッチメント対応のフィーチャー一式をスキャフォールドできます:

```bash
bunx guren make:feature Post --fields "title:string,body:text" --attach "cover:one,images:many"
```

`--attach` はカンマ区切りの `name:kind` ペア（`one` または `many`、省略時は
`one`）を受け取ります。生成されるモデルは各コレクションに
`image: 'require'` を付けた `Attachable` ミックスインでラップされ（画像以外の
アップロードにはコレクションごとにこのオプションを外してください）、store
アクションは同名の multipart フィールドを `this.file()` / `this.files()` で
読んで `Post.attach()` を呼び、destroy アクションは行の削除前に
`Post.purgeAttachments()` を呼びます。アプリに `configureAttachments()` が
ない場合、このコマンドはスキャフォールドを拒否します。先に
`bunx guren add attachments` を実行してください。生成された New
ページへの `<input type="file">` の追加は手動で行います（Inertia の
`useForm` はフォームデータに `File` が含まれると自動的に multipart POST に
切り替わります）。生成された `update()` はアタッチメントに触れません。
Edit ページからのアップロードも受け付けるには、同じ `this.file()` と
`Post.attach()` の行を `update()` にも追加してください（`hasOne` は置換、
`hasMany` は追加になります）。

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
- **フレームワークが配信する箇所は強化済みです。** 署名配信ルート([URL と可視性](#url-と可視性))を有効にすると、proxy 応答には inline allowlist(SVG と HTML は `attachment` に強制。同一オリジンのページとして表示される SVG はスクリプトになりえます)、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、`Referrer-Policy: no-referrer` が付きます。public ディスクは従来どおり `disk.url()` でアプリ側のルールに従って配信されるため、自分のドメインでユーザーのアップロードを配信する場合は正しい `Content-Type` と `nosniff` ヘッダを自分で付けてください。

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

public ディスクは常に `disk.url(path)` で配信されます。CDN にキャッシュでき、アプリの CPU を使いません。private ディスクには2つのモードがあります。

### 署名配信ルート(推奨)

`delivery` を有効にし、ルート登録関数でルートをマウントします:

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

private ディスクの `attachmentUrl()` は**パス相対の署名付き URL**(`/attachments/{id}/{filename}?expires=…&signature=…`)を返すようになります。アタッチメント配信専用に導出した鍵で HMAC 署名され、`urlExpiresIn` 後に失効します(URL 単位の上書きは `{ expiresIn }`、ダウンロード強制は `{ disposition: 'attachment' }`)。ルートは署名を検証し(失敗はすべて同一の 404)、variant を配信時に解決し(宣言済みだが未生成の variant はオリジナルを配信し、生成完了後は同じ URL が variant を配信し始めます)、その上で:

- ドライバが `capabilities.presignedGet` を宣言するディスク(S3、`presign` 付き R2)では短寿命の presigned URL へ **302 リダイレクト**します。バケットがバイト列を配信し、アプリの帯域を使いません。
- それ以外では強化ヘッダ付きで**プロキシ配信**します(inline allowlist、`nosniff`、`Content-Security-Policy: sandbox`、`Referrer-Policy: no-referrer`、ETag/304)。これにより **local ディスク上の private が本当に private になり**、**R2 の private ディスクが `presign` クレデンシャル無しのバインディングだけで動きます**。

ディスク単位の上書きは `disks` のオブジェクト形式で行います: `{ docs: { visibility: 'private', serve: 'proxy' } }`。`serve` は `'auto'`(デフォルト)、`'redirect'`、`'proxy'`、`'direct'`(ルートを使わず従来の `temporaryUrl()` URL を維持)です。`guren check` は `delivery` 設定時にルートがマウントされているかを検証し、presign できないドライバのディスクへの `serve: 'redirect'` も検出します。

ルートがやらないことが2つあります。これは capability URL でありリクエスト単位の認可ではありません(失効前の URL を持つ相手は誰でも読めます。取り消し可能なアクセスが必要なら `attachmentUrl()` を自分のコントローラでラップしてください)。また、裏のストア自体が公開されている状態を非公開にはできません。local ディスクでは private ディスクのディレクトリの静的配信も止めてください。公開マウントを閉じずにルートを登録するのは、開いたドアに鍵を付けるようなものです。

### `delivery` 無し(v1 の挙動)

private ディスクは `disk.temporaryUrl(path, expiry)` にフォールバックし、ドライバ由来の制限がそのまま残ります: `LocalDriver.temporaryUrl()` はただの公開 URL を返し(実際には private になりません)、R2 は `presign` クレデンシャルが必要です。`delivery` を有効にすると両方の穴が塞がります。

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

### 孤児の掃除: `attachments:prune`

契約は「明示的削除+スイープ」です。明示的なパージをすり抜けたもの、つまり `purgeAttachments()` を呼ばない経路で削除されたレコードの残骸や、クラッシュ・競合したジョブが残したストレージプレフィックスは、`AttachmentsPruneCommand` スイーパーが回収します。コンソールカーネルに登録してください:

```ts
// src/console.ts
import { AttachmentsPruneCommand } from '@guren/core'
kernel.register(AttachmentsPruneCommand)
```

```bash
bunx guren attachments:prune             # レコードが存在しない行を削除
bunx guren attachments:prune --objects   # どの行からも参照されない attachments/ プレフィックスも削除
bunx guren attachments:prune --dry-run   # 削除せずに報告のみ
```

孤児行は、各 `attachableType` を `Model.morphMap` で解決して所有レコードを問い合わせることで検出します。アタッチメントを宣言するモデルはすべて登録してください:

```ts
Model.morphMap = { Post, User }
```

スイープは肯定的な証拠があるときだけ削除します。morph map にない型、失敗した存在確認クエリ、リストできないディスクは報告して手を付けません。障害を大量削除に変えてはならないからです。スケジュールジョブや CI から、アプリに合った頻度で実行してください。

### 生成される型: `.guren/attachments.gen.ts`

モデル自体は mixin のジェネリクスで型付けされますが、ページ・リソース・アップロードクライアントからは `typeof Post.attachments` が見えません。`guren codegen` は各モデルの `Attachable(...)` 宣言を読み取り、境界を越えて使えるマップを生成します(Vite プラグインは `app/Models/` 配下、およびモジュールの同ディレクトリの変更時に再生成します):

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

`Attachable` モデルがないアプリにはファイルは生成されません。ジェネレータは宣言を静的に読むため、完全に解析できない宣言(スプレッドや、別の場所で組み立てたオプションオブジェクト)は部分的に出力せず、警告してスキップします。マップに含めたいモデルの宣言は、インラインのオブジェクトリテラルで書いてください。

### エージェントコマンドが検証すること

- `bunx guren check` は、`configureAttachments()` が `db/schema.ts` の実際にエクスポートされたテーブルを束縛していることを検証します。レイヤーはテーブルを型なしで受け取るため、スキーマエクスポートのリネームは本来、最初の attach 時の実行時エラーでしか発覚しません。
- `bunx guren check` はさらに、アプリに `configureAttachments()` の呼び出しがまったくないのに `Attachable(...)` を mixin するモデルも検出します。mixin はレイヤーを初回利用時に解決するため、設定の欠落も本来は実行時にしか発覚しません。
- `bunx guren audit` は、型付きの `attach()` に渡されるアップロードを検証済みとして扱います(宣言駆動のパイプラインが検証そのものです)。他のボディ入力を読むアクションには引き続き `validateBody()` が必要です。

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
