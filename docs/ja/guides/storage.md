# ストレージガイド

Gurenは複数のストレージバックエンドをサポートする統一されたファイルストレージAPIを提供します。ストレージシステムにより、ローカルファイルシステム、Amazon S3、その他のクラウドストレージプロバイダーを一貫したインターフェースで簡単に扱えます。

## コアコンセプト

- **StorageManager** – 複数のストレージディスクを設定・アクセスするための中央レジストリ。
- **StorageDriver** – ストレージ操作（put、get、deleteなど）のインターフェース。すべてのドライバがこのインターフェースを実装。
- **Drivers** – ストレージバックエンド：Local（ファイルシステム）、S3（AWS/互換サービス）、Memory（テスト用）。

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
  visibility: 'public',
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

```ts
const disk = storage.disk()

// アップロード時に可視性を設定
await disk.put('file.txt', content, { visibility: 'public' })

// 可視性を変更
await disk.setVisibility('file.txt', 'public')
await disk.setVisibility('file.txt', 'private')

// 現在の可視性を取得
const visibility = await disk.getVisibility('file.txt')
```

## 設定

### 複数のディスク

アプリケーションで複数のストレージバックエンドを設定：

```ts
import { StorageManager } from '@guren/core'

const storage = new StorageManager({
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
      bucket: process.env.AWS_BUCKET!,
      region: process.env.AWS_REGION ?? 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      visibility: 'private',
    },
    memory: {
      driver: 'memory',
    },
  },
})

// デフォルトディスク（local）を使用
await storage.disk().put('file.txt', 'content')

// 特定のディスクを使用
await storage.disk('s3').put('uploads/file.txt', content)
await storage.disk('public').put('images/logo.png', logoBuffer)
```

### ドライバオプション

**Local Driver:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `root` | 必須 | ファイルストレージのルートディレクトリ |
| `url` | `''` | 公開ファイルアクセス用のベースURL |
| `visibility` | `'private'` | 新規ファイルのデフォルト可視性 |

**S3 Driver:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `bucket` | 必須 | S3バケット名 |
| `region` | `'us-east-1'` | AWSリージョン |
| `endpoint` | - | カスタムエンドポイント（S3互換サービス用） |
| `accessKeyId` | - | AWSアクセスキーID |
| `secretAccessKey` | - | AWSシークレットアクセスキー |
| `prefix` | `''` | 全ファイルのキープレフィックス |
| `url` | 自動 | 公開アクセス用のベースURL |
| `visibility` | `'private'` | 新規ファイルのデフォルト可視性 |

**Memory Driver:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `url` | `''` | ファイルURL用のベースURL |

## S3設定

### AWS S3

```ts
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'ap-northeast-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  },
})
```

### S3互換サービス

MinIO、DigitalOcean Spaces、Cloudflare R2などのサービス向け：

```ts
// MinIO
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
    },
  },
})

// DigitalOcean Spaces
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-space',
      region: 'nyc3',
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      accessKeyId: process.env.DO_SPACES_KEY,
      secretAccessKey: process.env.DO_SPACES_SECRET,
      url: 'https://my-space.nyc3.cdn.digitaloceanspaces.com',
    },
  },
})

// Cloudflare R2
const storage = new StorageManager({
  default: 's3',
  disks: {
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'auto',
      endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  },
})
```

### 署名付きURL

プライベートファイル用の一時URLを生成：

```ts
const disk = storage.disk('s3')

// 1時間有効なURL
const expiration = new Date(Date.now() + 3600 * 1000)
const url = await disk.temporaryUrl('private/document.pdf', expiration)
```

## ファイルアップロード

### フォームアップロードの処理

```ts
import { Controller } from '@guren/server'

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

    await storage.disk().put(filename, buffer, {
      contentType: file.type,
      visibility: 'public',
    })

    const url = storage.disk().url(filename)

    return this.json({ url })
  }
}
```

### 大きなファイルのストリーミング

大きなファイルの場合はストリーミングを検討：

```ts
import { Controller } from '@guren/server'

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

テストにはMemoryドライバを使用：

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

1. **環境変数を使用**: 認証情報やバケット名をハードコードしない。

2. **アップロードを検証**: 保存前にファイルタイプ、サイズ、コンテンツを必ず検証。

3. **一意なファイル名を生成**: UUIDやタイムスタンプを使用して衝突を回避。

4. **適切な可視性を使用**: デフォルトはprivateにし、必要な場合のみファイルを公開。

5. **署名付きURLを使用**: プライベートファイルには公開せず一時URLを生成。

6. **ディレクトリで整理**: 意味のあるディレクトリ構造を使用（`avatars/`、`documents/`など）。

7. **テストにはMemoryドライバを使用**: テストでファイルシステムやネットワーク呼び出しを避ける。

8. **エラーを適切に処理**: `get()`や`metadata()`からのnull戻り値を確認。
