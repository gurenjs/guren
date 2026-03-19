# ファイルストレージ

Gurenは複数のストレージバックエンドで動作する強力なファイルシステム抽象化を提供します。ローカル、S3、またはテスト用のメモリにファイルを保存できます。

## 設定

アプリケーションでストレージディスクを設定します：

```typescript
import { createStorageManager } from '@guren/server'

const storage = createStorageManager({
  default: 'local',
  disks: {
    local: {
      driver: 'local',
      root: './storage/app',
      url: 'http://localhost:3333/storage',
      visibility: 'private',
    },
    public: {
      driver: 'local',
      root: './storage/app/public',
      url: 'http://localhost:3333/storage',
      visibility: 'public',
    },
    s3: {
      driver: 's3',
      bucket: 'my-bucket',
      region: 'ap-northeast-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      visibility: 'private',
    },
  },
})
```

## 基本的な使い方

### ファイルの保存

```typescript
// バッファまたは文字列から保存
await storage.disk().put('avatars/user-1.jpg', imageBuffer)
await storage.disk().put('documents/readme.txt', 'Hello World')

// オプション付きで保存
await storage.disk().put('avatars/user-1.jpg', imageBuffer, {
  visibility: 'public',
  contentType: 'image/jpeg',
  metadata: { userId: '123' },
})

// ローカルファイルパスから保存
await storage.disk().putFile('uploads/document.pdf', '/tmp/uploaded.pdf')
```

### ファイルの取得

```typescript
// Bufferとして取得
const content = await storage.disk().get('avatars/user-1.jpg')

// 文字列として取得
const text = await storage.disk().getAsString('documents/readme.txt')

// ファイルの存在確認
const exists = await storage.disk().exists('avatars/user-1.jpg')
```

### ファイルの削除

```typescript
// 単一ファイルを削除
await storage.disk().delete('avatars/user-1.jpg')

// 複数ファイルを削除
await storage.disk().deleteMany([
  'avatars/user-1.jpg',
  'avatars/user-2.jpg',
])
```

### コピーと移動

```typescript
// ファイルをコピー
await storage.disk().copy('avatars/user-1.jpg', 'backups/user-1.jpg')

// ファイルを移動
await storage.disk().move('temp/upload.jpg', 'avatars/user-1.jpg')
```

## ファイルURL

### 公開URL

```typescript
// 公開URLを取得
const url = storage.disk().url('avatars/user-1.jpg')
// → "http://localhost:3333/storage/avatars/user-1.jpg"
```

### 一時URL（署名付き）

```typescript
// 1時間後に期限切れになる署名付きURLを取得
const expiration = new Date(Date.now() + 60 * 60 * 1000)
const signedUrl = await storage.disk('s3').temporaryUrl('documents/invoice.pdf', expiration)
```

## ファイルメタデータ

```typescript
// ファイルサイズを取得
const size = await storage.disk().size('documents/report.pdf')

// 最終更新日時を取得
const lastModified = await storage.disk().lastModified('documents/report.pdf')

// 完全なメタデータを取得
const metadata = await storage.disk().metadata('documents/report.pdf')
// { path, size, lastModified, contentType, visibility, metadata }
```

## ディレクトリ操作

```typescript
// ディレクトリ内のファイル一覧
const files = await storage.disk().files('avatars')
// ['avatars/user-1.jpg', 'avatars/user-2.jpg']

// 再帰的にすべてのファイルを一覧
const allFiles = await storage.disk().allFiles('uploads')

// ディレクトリ一覧
const directories = await storage.disk().directories('uploads')

// ディレクトリ作成
await storage.disk().makeDirectory('uploads/2024/01')

// ディレクトリ削除
await storage.disk().deleteDirectory('uploads/temp')
```

## 可視性

ファイルアクセス権限を制御します：

```typescript
// 可視性を設定
await storage.disk().setVisibility('documents/public.pdf', 'public')
await storage.disk().setVisibility('documents/private.pdf', 'private')

// 可視性を取得
const visibility = await storage.disk().getVisibility('documents/public.pdf')
// → 'public' または 'private'
```

## ストレージドライバー

### ローカルドライバー

ローカルファイルシステムにファイルを保存：

```typescript
{
  driver: 'local',
  root: './storage/app',      // ルートディレクトリ
  url: 'http://localhost:3333/storage',  // 公開ファイルのベースURL
  visibility: 'private',      // デフォルトの可視性
}
```

### S3ドライバー

AWS S3またはS3互換サービスにファイルを保存：

S3ドライバーを使う前にAWS SDKをインストールしてください：

```bash
bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

```typescript
{
  driver: 's3',
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  endpoint: 'https://s3.amazonaws.com',  // S3互換サービスのカスタムエンドポイント
  prefix: 'app/',                         // キープレフィックス
  visibility: 'private',
}
```

### メモリドライバー

テスト用のインメモリストレージ：

```typescript
{
  driver: 'memory',
  url: 'http://localhost:3333/storage',
}
```

## 複数ディスク

異なるストレージディスクにアクセス：

```typescript
// デフォルトディスクを使用
await storage.disk().put('file.txt', 'content')

// 特定のディスクを使用
await storage.disk('s3').put('file.txt', 'content')
await storage.disk('public').put('images/logo.png', imageBuffer)
```

## カスタムドライバー

カスタムストレージドライバーを登録：

```typescript
import { StorageDriver } from '@guren/server'

class CloudinaryDriver implements StorageDriver {
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<string> {
    // 実装
  }
  // ... 他のメソッドを実装
}

// ドライバーを登録
storage.registerDriver('cloudinary', (options) => new CloudinaryDriver(options))

// 設定で使用
{
  driver: 'cloudinary',
  cloudName: 'my-cloud',
  apiKey: '...',
}
```

## コントローラー統合

コントローラーでストレージを使用：

```typescript
import { Controller } from '@guren/server'

export default class UploadController extends Controller {
  async store() {
    const file = await this.request.file('avatar')

    if (!file) {
      return this.json({ error: 'ファイルがアップロードされていません' }, 400)
    }

    const path = `avatars/${Date.now()}-${file.name}`
    await storage.disk().put(path, file.buffer, {
      contentType: file.type,
      visibility: 'public',
    })

    const url = storage.disk().url(path)

    return this.json({ url })
  }
}
```

## CLIコマンド

### ストレージリンク作成

`public/storage`から`storage/app/public`へのシンボリックリンクを作成：

```bash
bunx guren storage:link
```

これにより、アップロードされたファイルをパブリックディレクトリから提供できます。

## ベストプラクティス

1. **環境変数を使用** - 認証情報用
2. **適切な可視性を設定** - デフォルトはprivate
3. **ユニークなファイル名を生成** - 上書きと競合を防止
4. **本番環境ではS3を使用** - より良いスケーラビリティと耐久性
5. **テストにはメモリドライバー** - 高速で分離
6. **一時ファイルをクリーンアップ** - 処理後にファイルを削除
