# メールガイド

Gurenはメール送信のための流暢なAPIを提供し、複数のトランスポートバックエンドをサポートしています。メールシステムはキューシステムと統合して非同期送信を実現し、HTMLテンプレート、添付ファイルなどをサポートします。

## コアコンセプト

- **MailManager** – メールトランスポートを設定・アクセスするための中央レジストリ。
- **Mail** – メールを作成・送信するための流暢なビルダー。
- **Transport** – メール配信バックエンド。GurenにはSMTP、Resend、Memory（テスト用）トランスポートが付属。

## 基本的な使い方

### クイックスタート

```ts
import { MailManager, mail } from '@guren/core'

const mailManager = new MailManager({
  default: 'smtp',
  from: { email: 'noreply@example.com', name: 'MyApp' },
  transports: {
    smtp: {
      driver: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      auth: { user: 'user', pass: 'password' },
    },
  },
})

// シンプルなメールを送信
await mail(mailManager)
  .to('user@example.com')
  .subject('Hello!')
  .text('Hello World!')
  .send()
```

### 流暢なAPI

```ts
const builder = mail(mailManager)

// 宛先
builder.to('user@example.com')                    // 受信者を追加
builder.to({ email: 'user@example.com', name: 'John' })  // 名前付き
builder.toMany(['a@example.com', 'b@example.com']) // 複数の受信者
builder.cc('copy@example.com')                    // CC受信者
builder.bcc('blind@example.com')                  // BCC受信者

// 送信者と返信先
builder.from('sender@example.com')                // デフォルトの送信元を上書き
builder.replyTo('support@example.com')            // 返信先アドレス

// コンテンツ
builder.subject('Welcome!')                       // メール件名
builder.text('Plain text body')                   // プレーンテキスト
builder.html('<h1>HTML body</h1>')               // HTMLコンテンツ

// 添付ファイル
builder.attach({
  filename: 'report.pdf',
  path: './storage/report.pdf',
})
builder.attach({
  filename: 'data.json',
  content: JSON.stringify(data),
  contentType: 'application/json',
})

// ヘッダー
builder.header('X-Custom-Header', 'value')

// 送信
await builder.send()
```

## 設定

### 複数のトランスポート

異なるユースケースに対応するため、複数のメールバックエンドを設定：

```ts
import { MailManager, mail } from '@guren/core'

const mailManager = new MailManager({
  default: 'smtp',
  from: { email: 'noreply@example.com', name: 'MyApp' },
  transports: {
    smtp: {
      driver: 'smtp',
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    },
    resend: {
      driver: 'resend',
      apiKey: process.env.RESEND_API_KEY,
    },
    memory: {
      driver: 'memory',
    },
  },
})

// デフォルトトランスポート（smtp）を使用
await mail(mailManager).to('user@example.com').subject('Test').text('Hello').send()

// 特定のトランスポートを使用
await mail(mailManager)
  .via('resend')
  .to('user@example.com')
  .subject('Via Resend')
  .text('Hello')
  .send()
```

### トランスポートオプション

**SMTP Transport:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `host` | 必須 | SMTPサーバーのホスト名 |
| `port` | `587` | SMTPサーバーのポート |
| `secure` | `false` | TLSを使用（通常ポート465で使用） |
| `auth.user` | - | SMTPユーザー名 |
| `auth.pass` | - | SMTPパスワード |
| `pool` | `true` | コネクションプーリングを使用 |
| `maxConnections` | `5` | 最大プール接続数 |

**Resend Transport:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `apiKey` | 必須 | Resend APIキー |

**Memory Transport（テスト用）:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `simulateFailure` | `false` | 送信失敗をシミュレート |
| `failureMessage` | - | 失敗時のエラーメッセージ |

## HTMLテンプレート

### React Emailの使用

Gurenは型安全なメールテンプレートのために[React Email](https://react.email/)と統合できます：

```bash
bun add @react-email/render react
```

```tsx
// app/Mail/WelcomeEmail.tsx
import * as React from 'react'
import { Html, Head, Body, Container, Text, Button } from '@react-email/components'

interface WelcomeEmailProps {
  name: string
  loginUrl: string
}

export function WelcomeEmail({ name, loginUrl }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'sans-serif' }}>
        <Container>
          <Text>こんにちは {name}さん！</Text>
          <Text>アプリケーションへようこそ。</Text>
          <Button href={loginUrl}>始める</Button>
        </Container>
      </Body>
    </Html>
  )
}
```

```ts
import { mail } from '@guren/core'
import { WelcomeEmail } from '@/app/Mail/WelcomeEmail'

await mail(mailManager)
  .to('user@example.com')
  .subject('ようこそ！')
  .template(WelcomeEmail, { name: 'John', loginUrl: 'https://example.com/login' })
  .send()
```

### プレーンHTMLの使用

```ts
await mail(mailManager)
  .to('user@example.com')
  .subject('ようこそ！')
  .html(`
    <h1>ようこそ、${user.name}さん！</h1>
    <p>ご登録ありがとうございます。</p>
    <a href="${loginUrl}">始める</a>
  `)
  .send()
```

## 添付ファイル

```ts
// ファイル添付
await mail(mailManager)
  .to('user@example.com')
  .subject('レポート')
  .text('レポートを添付しました。')
  .attach({
    filename: 'report.pdf',
    path: './storage/reports/monthly.pdf',
  })
  .send()

// インラインコンテンツ
await mail(mailManager)
  .to('user@example.com')
  .subject('データエクスポート')
  .text('データエクスポートの準備ができました。')
  .attach({
    filename: 'data.json',
    content: JSON.stringify(exportData, null, 2),
    contentType: 'application/json',
  })
  .send()

// インライン画像（CID）
await mail(mailManager)
  .to('user@example.com')
  .subject('ニュースレター')
  .html('<img src="cid:logo" alt="ロゴ" /><p>ようこそ！</p>')
  .attach({
    filename: 'logo.png',
    path: './public/logo.png',
    cid: 'logo',
  })
  .send()
```

## キューによるメール送信

キューシステムを使用してメールを非同期で送信：

```ts
import { mail, setMailManager, setQueueDriver, MemoryDriver } from '@guren/core'

// キュードライバを設定
setQueueDriver(new MemoryDriver())

// キュージョブ用にグローバルメールマネージャーを設定
setMailManager(mailManager)

// 即座に送信せずキューに入れる
await mail(mailManager)
  .to('user@example.com')
  .subject('週次レポート')
  .html(reportHtml)
  .queue('emails')  // キュー名

// メールはワーカーによって処理される
// bunx guren queue:work --queue=emails
```

## Mailableクラス

再利用可能なメールテンプレート用のMailableクラスを生成：

```bash
bunx guren make:mail WelcomeMail
```

```ts
// app/Mail/WelcomeMail.ts
import { Mail, MailManager } from '@guren/core'

interface WelcomeMailData {
  user: { name: string; email: string }
  loginUrl: string
}

export class WelcomeMail {
  constructor(
    private readonly manager: MailManager,
    private readonly data: WelcomeMailData
  ) {}

  async send(): Promise<void> {
    const { user, loginUrl } = this.data

    await new Mail(this.manager)
      .to(user.email)
      .subject(`ようこそ、${user.name}さん！`)
      .html(`
        <h1>MyAppへようこそ！</h1>
        <p>こんにちは ${user.name}さん、</p>
        <p>ご参加ありがとうございます。</p>
        <a href="${loginUrl}">始める</a>
      `)
      .send()
  }

  async queue(queueName: string = 'emails'): Promise<string> {
    const { user, loginUrl } = this.data

    return new Mail(this.manager)
      .to(user.email)
      .subject(`ようこそ、${user.name}さん！`)
      .html(`
        <h1>MyAppへようこそ！</h1>
        <p>こんにちは ${user.name}さん、</p>
        <p>ご参加ありがとうございます。</p>
        <a href="${loginUrl}">始める</a>
      `)
      .queue(queueName)
  }
}

// 使用方法
const welcomeMail = new WelcomeMail(mailManager, {
  user: { name: 'John', email: 'john@example.com' },
  loginUrl: 'https://example.com/login',
})

await welcomeMail.send()
// または
await welcomeMail.queue('emails')
```

## テスト

テストにはMemoryトランスポートを使用：

```ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { MailManager, mail, MemoryTransport } from '@guren/core'

describe('Email', () => {
  let mailManager: MailManager
  let memoryTransport: MemoryTransport

  beforeEach(() => {
    memoryTransport = new MemoryTransport()

    mailManager = new MailManager({
      default: 'memory',
      from: { email: 'test@example.com' },
    })
    mailManager.registerTransport('memory', () => memoryTransport)
  })

  test('ウェルカムメールを送信する', async () => {
    await mail(mailManager)
      .to('user@example.com')
      .subject('ようこそ！')
      .text('Hello World!')
      .send()

    const sent = memoryTransport.getSentMessages()
    expect(sent).toHaveLength(1)
    expect(sent[0].to[0].email).toBe('user@example.com')
    expect(sent[0].subject).toBe('ようこそ！')
  })

  test('添付ファイル付きメールを送信する', async () => {
    await mail(mailManager)
      .to('user@example.com')
      .subject('レポート')
      .text('添付をご確認ください。')
      .attach({ filename: 'data.txt', content: 'test data' })
      .send()

    const sent = memoryTransport.getSentMessages()
    expect(sent[0].attachments).toHaveLength(1)
    expect(sent[0].attachments![0].filename).toBe('data.txt')
  })
})
```

## ベストプラクティス

1. **環境変数を使用**: SMTP認証情報やAPIキーをハードコードしない。

2. **デフォルトの送信元を設定**: 繰り返しを避けるためデフォルトの送信者を設定。

3. **大量メールにはキュー送信を使用**: 同期送信でリクエストをブロックしない。

4. **複雑なテンプレートにはReact Emailを使用**: 型安全なテンプレートは保守が容易。

5. **Memoryトランスポートでテスト**: テストで実際のメールを送信しない。

6. **送信失敗を処理**: `SendResult`を確認し、重要なメールにはリトライロジックを実装。

7. **意味のある件名を使用**: 明確な件名はメールの配信率とユーザー体験を向上させる。
