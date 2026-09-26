# ストレージガイド

Guren のファイルストレージ API を使うと、ローカルのファイルシステム、Amazon S3、その他のクラウドストレージを、同じインターフェースで同じように扱えます。

## コアコンセプト

- **StorageManager**: 複数のストレージディスクを設定し、それぞれにアクセスするための中央レジストリ。
- **StorageDriver**: ストレージ操作（put、get、delete など）のインターフェース。すべてのドライバがこれを実装します。
- **Drivers**: ストレージのバックエンド。Local（ファイルシステム）、S3（AWS と互換サービス）、Memory（テスト用）があります。

## 基本的な使い方

### クイックスタート

```ts
import { StorageManager } from '@guren/core'

const storage = new StorageManager({
  default: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
      url: '/storage',
    },
  },
})

// ファイルを保存
await storage.disk().put('avatars/user-1.jpg', imageBuffer)

// ファイルを取得
const content = await storage.disk().get('avatars/user-1.jpg')

// ファイルが存在するか確認
const exists = await storage.disk().exists('avatars/user-1.jpg')

// ファイルを削除
await storage.disk().delete('avatars/user-1.jpg')
```

### ファイル操作

```ts
const disk = storage.disk()

// ファイルの保存
await disk.put('file.txt', 'Hello World')                    // 文字列コンテンツ
await disk.put('image.jpg', imageBuffer)                      // Bufferコンテンツ
await disk.put('data.json', JSON.stringify(data), {          // オプション付き
  contentType: 'application/json',
})
await disk.putFile('uploads/report.pdf', './temp/report.pdf') // ローカルファイルから

// ファイルの取得
const buffer = await disk.get('file.txt')                    // Bufferとして取得
const text = await disk.getAsString('file.txt')              // 文字列として取得

// ファイルの存在確認
const exists = await disk.exists('file.txt')

// ファイルの削除
await disk.delete('file.txt')                                // 単一ファイル
await disk.deleteMany(['file1.txt', 'file2.txt'])            // 複数ファイル

// コピーと移動
await disk.copy('original.txt', 'copy.txt')
await disk.move('old-path.txt', 'new-path.txt')
```

### ファイルメタデータ

```ts
const disk = storage.disk()

// ファイルサイズを取得（バイト）
const size = await disk.size('file.txt')

// 最終更新日時を取得
const lastModified = await disk.lastModified('file.txt')

// 全メタデータを取得
const metadata = await disk.metadata('file.txt')
// { path, size, lastModified, contentType?, visibility?, metadata? }
```

### URL

```ts
const disk = storage.disk()

// 公開URLを取得
const url = disk.url('avatars/user-1.jpg')
// 例: '/storage/avatars/user-1.jpg' (local)
// 例: 'https://bucket.s3.region.amazonaws.com/avatars/user-1.jpg' (S3)

// 一時署名付きURLを取得（S3のみ）
const expiration = new Date(Date.now() + 3600 * 1000) // 1時間
const signedUrl = await disk.temporaryUrl('private/report.pdf', expiration)
```

### ディレクトリ

```ts
const disk = storage.disk()

// ディレクトリ内のファイルを一覧
const files = await disk.files('uploads')              // 直接の子のみ
const allFiles = await disk.allFiles('uploads')        // 再帰的

// サブディレクトリを一覧
const dirs = await disk.directories('uploads')

// ディレクトリを作成
await disk.makeDirectory('uploads/images')

// ディレクトリを削除（中身含む）
await disk.deleteDirectory('uploads/temp')
```

### 可視性

可視性をファイルごとに持つか、ディスクごとに持つかはバックエンドによって違います。ドライバは使えない機能を使えるように見せかけることはせず、どちらの方式なのかをはっきり伝えます。

- **オブジェクト単位**: ACL が有効な S3。`setVisibility()` はファイルを 1 つだけ変更します。
- **ディスク単位**: ローカルディスク（外からアクセスできるかどうかは、ディスクのルートとそれを配信する仕組みで決まります）、`acl: false` の S3、Cloudflare R2。可視性はディスク側で `visibility` として宣言し、それと逆の値を求められた場合は、黙って何もしないのではなく拒否します。S3 と R2 ではすでにエラーになります。ローカルドライバはこれまでこうした呼び出しを受け付けてきたため、今は警告を出すだけで、次のメジャーバージョンからエラーになります。

```ts
const disk = storage.disk('public')       // visibility: 'public' を宣言したディスク

await disk.put('file.txt', content)                  // ディスクの可視性を継承
await disk.put('file.txt', content, { visibility: 'public' })  // 同じ意味を明示しただけ
await disk.getVisibility('file.txt')                 // 'public'（ファイルが無ければ例外）

// オブジェクト単位のバックエンドでは1ファイルだけ移動します
await storage.disk('s3').setVisibility('file.txt', 'private')

// ディスク単位のバックエンドでは、黙って捨てられるのではなく拒否されます。
// 代わりに目的の可視性を持つディスクへ置いてください。
await storage.disk('local').put('secret.pdf', content)
```

## 設定

### 複数のディスク

アプリが使うディスクは `config/storage.ts` で宣言します。各ディスクの認証情報は、検証済みの `env` から読みます。

```ts
// config/storage.ts
import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig((env) => ({
  default: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
      url: '/storage',
      visibility: 'private',
    },
    public: {
      driver: 'local',
      root: './storage/public',
      url: '/files',
      visibility: 'public',
    },
    s3: {
      driver: 's3',
      bucket: env.AWS_BUCKET ?? '',
      region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      visibility: 'private',
    },
    memory: {
      driver: 'memory',
    },
  },
}))
```

```ts
// src/app.ts
import { createApp } from '@guren/core'
import env from '../config/env.js'
import storage from '../config/storage.js'

const app = createApp({ env, config: [storage] })
```

コールバックが読むキー（`AWS_BUCKET`、`AWS_REGION` など）は、すべて `config/env.ts` で宣言しておいてください（[設定ガイド](./configuration.md)を参照）。この定義は manager を `storage` という名前でバインドするので、コードからはコンテナで解決して使います。

```ts
const storage = app.container.make('storage')

// デフォルトディスク（local）を使用
await storage.disk().put('file.txt', 'content')

// 特定のディスクを使用
await storage.disk('s3').put('uploads/file.txt', content)
await storage.disk('public').put('images/logo.png', logoBuffer)
```

ストレージをサービスプロバイダで設定しているアプリも、そのまま動きます。詳しくは [サービスプロバイダを使うアプリ](./configuration.md#サービスプロバイダを使うアプリ) を参照してください。

### ドライバオプション

**Local Driver:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `root` | 必須 | ファイルを保存するルートディレクトリ |
| `url` | `''` | 公開ファイルにアクセスするときのベース URL |
| `visibility` | `'private'` | 新しいファイルのデフォルトの可視性 |

ローカルディスクは、シンボリックリンクをたどってディスクの外に出るパスを拒否します。リンク先が存在せず、その位置がディスクの外を指している場合も同様です。ディスクの中で完結するリンクはふつうにたどり、設定した `root` 自体がシンボリックリンクでもかまいません。ただし、処理の途中で別のプロセスがディレクトリを差し替える競合まではパスのチェックで防げません。ルートとその親ディレクトリは、信頼できるユーザーだけが書き込めるようにしておいてください。

**S3 Driver:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `bucket` | 必須 | S3 のバケット名 |
| `region` | `'us-east-1'` | AWS のリージョン |
| `endpoint` | - | カスタムエンドポイント（S3 互換サービス用） |
| `accessKeyId` | - | AWS のアクセスキー ID |
| `secretAccessKey` | - | AWS のシークレットアクセスキー |
| `prefix` | `''` | すべてのファイルのキーに付けるプレフィックス |
| `url` | 自動 | 公開アクセスに使うベース URL |
| `visibility` | `'private'` | 新しいファイルのデフォルトの可視性 |

**Memory Driver:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `url` | `''` | ファイルの URL に使うベース URL |

## S3設定

### AWS S3

```ts
// config/storage.ts
import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig((env) => ({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'ap-northeast-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  },
}))
```

### S3互換サービス

MinIO、DigitalOcean Spaces、Cloudflare R2 などのサービスは、S3 ドライバの接続先をそのサービスのエンドポイントに向ければ使えます。`disks` にはサービスごとにエントリを 1 つずつ追加します。

```ts
// config/storage.ts
import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig((env) => ({
  default: 'minio',
  disks: {
    minio: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    },
    spaces: {
      driver: 's3',
      bucket: 'my-space',
      region: 'nyc3',
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      accessKeyId: env.DO_SPACES_KEY,
      secretAccessKey: env.DO_SPACES_SECRET,
      url: 'https://my-space.nyc3.cdn.digitaloceanspaces.com',
    },
    r2: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'auto',
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  },
}))
```

これらのディスクが読むキー（`DO_SPACES_KEY`、`CF_ACCOUNT_ID`、`R2_ACCESS_KEY_ID` など）は `config/env.ts` で宣言します。アプリが使うディスクのエンドポイントを組み立てる `CF_ACCOUNT_ID` のようなキーは、必須として宣言してください。`.optional()` で宣言したまま値を設定し忘れると、エンドポイントが `https://undefined.r2.cloudflarestorage.com` になってしまいます。

S3 のオブジェクト ACL に対応していないエンドポイント（R2 は `x-amz-acl` と ACL 操作に対応していないと明記しており、MinIO は構成によって異なります）では、`acl: false` を指定します。するとドライバはこのヘッダを送らなくなり、`getVisibility()` はディスクに設定した `visibility` を返すようになります。`put({ visibility })` や `setVisibility()` でそれと逆の値を求められた場合は、黙って無視せずに例外を投げます。

```ts
// config/storage.ts
import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig((env) => ({
  default: 'r2',
  disks: {
    r2: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'auto',
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      acl: false,
      visibility: 'public',
    },
  },
}))
```

> [!NOTE]
> Cloudflare Workers 上では、S3 API の代わりにバケットバインディングを使ってください。`@guren/plugin-cloudflare` の `R2Driver` を使えば、資格情報も AWS SDK も要りません。上の S3 のレシピは、ほかのランタイム（Bun サーバー、スクリプト、Lambda）から R2 を使うためのものです。詳しくは [Cloudflare Workers ガイド](./cloudflare.md#ストレージr2)を参照してください。

### 署名付きURL

プライベートなファイルには、一時的な URL を発行できます。

```ts
const disk = storage.disk('s3')

// 1時間有効なURL
const expiration = new Date(Date.now() + 3600 * 1000)
const url = await disk.temporaryUrl('private/document.pdf', expiration)
```

### 環境ごとのディスク切り替え

ディスクはすべて一度に宣言しておき、使うものを環境変数で選びます（`bunx guren add storage` もこの形で生成します）。ドライバは初めて使うときに作られるので、使わないディスクのクライアントが作られたり、接続が開かれたりすることはありません。

```ts
// config/storage.ts
import { defineStorageConfig, type DiskConfig } from '@guren/core'

export default defineStorageConfig((env) => {
  const disks: Record<string, DiskConfig> = {
    // 何からも配信されません。アップロードはこちらへ（下の注記を参照）。
    local: { driver: 'local', root: './storage/app' },
    // public/ の中にあるため配信されます。自分で用意するアセット向け。
    public: { driver: 'local', root: './public/storage', url: '/storage', visibility: 'public' },
  }

  if (env.S3_BUCKET) {
    disks.s3 = { driver: 's3', bucket: env.S3_BUCKET, region: 'ap-northeast-1' }
  }

  if (!Object.hasOwn(disks, env.STORAGE_DISK)) {
    throw new Error(
      `STORAGE_DISK="${env.STORAGE_DISK}" is not a declared disk. Declare it in config/storage.ts or use one of: ${Object.keys(disks).join(', ')}.`,
    )
  }

  return { default: env.STORAGE_DISK, disks }
})
```

開発では `STORAGE_DISK=local`、本番では `STORAGE_DISK=s3` にします。コードは書き換えずに済み、`storage.disk()` が選んだほうのディスクを返します。`STORAGE_DISK` は `guren add storage` が宣言しますが、`S3_BUCKET` は自分で `config/env.ts` に宣言してください。

> **アップロードを受け取るディスクを、`public/` の下や `guren storage:link` が公開する場所に置かないでください。** 配信されるディレクトリの下にあるファイルは、署名も有効期限も認可のチェックもなしに、URL だけで取得できてしまいます。見知らぬ人がアップロードしたファイルも例外ではありません。アップロードは上の `local` のようなディスクに保存し、[attachments の配信ルート](./attachments.md)から渡してください。ディスクがそのように公開される attachments の設定は、`guren check` が失敗として報告します。

この形には、注意点が 2 つあります。

- **使わないディスクの設定値も起動時に読まれます。** コールバックは、`config/env.ts` の検証が終わったあと、アプリの起動時に実行されるからです。一部の環境のディスクでしか使わない変数は、`.optional()` で宣言してください。必須として宣言すると、そのディスクを使わない環境でも、変数が未設定なら起動に失敗します。上の `S3_BUCKET` のように変数があるときだけディスクを追加すれば、設定のない環境ではディスク自体がマップに入りません。
- **存在しないディスク名は manager では検出されません。** manager は `default: 'typo'` をそのまま受け付け、最初にディスクを解決したときに初めて `Storage disk not found: typo` を投げます。それがキューのジョブの中で起きることもあります。生成される `config/storage.ts` が起動時に `STORAGE_DISK` をディスクのマップと照らし合わせているのはこのためで、上の定義も同じ確認をしています。`S3_BUCKET` を設定しないまま `STORAGE_DISK=s3` にすると、最初のアップロードではなく起動の時点で失敗します。

## ファイルアップロード

> 投稿のカバー画像やユーザーのアバターのように、モデルに属するアップロードには[アタッチメントレイヤー](./attachments.md)を使えます。名前の付け方、保存、画像のバリデーション、サムネイルのバリアント、後片付けまでを、`Post.attach(post.id, 'cover', file)` の 1 回の呼び出しで済ませられます。ここから先のレシピでは、より低レベルな、パスを指定して使うストレージ API を扱います。

### フォームアップロードの処理

```ts
import { Controller } from '@guren/core'

export class UploadController extends Controller {
  async store() {
    const formData = await this.request.formData()
    const file = formData.get('avatar') as File

    if (!file) {
      return this.json({ error: 'ファイルがアップロードされていません' }, 400)
    }

    // ファイルを検証
    if (!file.type.startsWith('image/')) {
      return this.json({ error: '無効なファイルタイプです' }, 400)
    }

    if (file.size > 5 * 1024 * 1024) { // 5MB
      return this.json({ error: 'ファイルが大きすぎます' }, 400)
    }

    // ファイルを保存
    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = file.name.split('.').pop()
    const filename = `avatars/${crypto.randomUUID()}.${ext}`

    // The public disk declares its own visibility, so the upload does not
    // have to ask for one the disk may not be able to honour.
    await storage.disk('public').put(filename, buffer, {
      contentType: file.type,
    })

    const url = storage.disk('public').url(filename)

    return this.json({ url })
  }
}
```

### 大きなファイルのストリーミング

サイズの大きいファイルを扱うときは、ストリーミングも検討してください。

```ts
import { Controller } from '@guren/core'

export class DownloadController extends Controller {
  async show() {
    const path = this.request.param('path')
    const content = await storage.disk().get(path)

    if (!content) {
      return this.notFound()
    }

    const metadata = await storage.disk().metadata(path)

    return new Response(content, {
      headers: {
        'Content-Type': metadata?.contentType ?? 'application/octet-stream',
        'Content-Length': String(content.length),
        'Content-Disposition': `attachment; filename="${path.split('/').pop()}"`,
      },
    })
  }
}
```

## テスト

テストでは Memory ドライバを使います。

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { StorageManager, MemoryDriver } from '@guren/core'

describe('ファイルアップロード', () => {
  let storage: StorageManager

  beforeEach(() => {
    storage = new StorageManager({
      default: 'memory',
      disks: {
        memory: { driver: 'memory' },
      },
    })
  })

  test('アップロードされたファイルを保存する', async () => {
    const content = Buffer.from('test content')
    await storage.disk().put('test.txt', content)

    expect(await storage.disk().exists('test.txt')).toBe(true)
    expect(await storage.disk().getAsString('test.txt')).toBe('test content')
  })

  test('ファイルを削除する', async () => {
    await storage.disk().put('test.txt', 'content')
    await storage.disk().delete('test.txt')

    expect(await storage.disk().exists('test.txt')).toBe(false)
  })

  test('ディレクトリ内のファイルを一覧する', async () => {
    await storage.disk().put('uploads/file1.txt', 'content1')
    await storage.disk().put('uploads/file2.txt', 'content2')

    const files = await storage.disk().files('uploads')
    expect(files).toHaveLength(2)
  })
})
```

## ベストプラクティス

1. **環境変数を使う**: 認証情報やバケット名はハードコードせず、`config/env.ts` で宣言して `config/storage.ts` で読みます。

2. **アップロードを検証する**: 保存する前に、ファイルの種類、サイズ、内容を必ず検証します。

3. **重複しないファイル名にする**: UUID やタイムスタンプを使って、名前の衝突を避けます。

4. **可視性を適切に設定する**: デフォルトは private にし、必要なファイルだけを公開します。

5. **署名付き URL を使う**: プライベートなファイルは公開せず、一時的な URL を発行します。モデルのアタッチメントなら、[署名付きの配信ルート](./attachments.md#url-と可視性)がどのドライバでもこの役割を担います(local ディスクや、バインディングしかない R2 でも使えます)。

6. **ディレクトリで整理する**: `avatars/`、`documents/` のように、意味のあるディレクトリ構成にします。

7. **テストには Memory ドライバを使う**: テストでファイルシステムやネットワークに触れないようにします。

8. **エラーをきちんと扱う**: `get()` や `metadata()` が null を返す場合を確認します。
