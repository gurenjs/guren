# メールガイド

Guren のメール送信は Fluent API で書け、トランスポートのバックエンドを複数使い分けられます。キューと組み合わせれば非同期に送信でき、HTML テンプレートや添付ファイルにも対応しています。

推奨パターン: `@guren/core` から mail API をインポートし、provider で mail manager を構成します。コントローラーではメールの組み立てと送信に集中します。

## コアコンセプト

- **MailManager**: メールトランスポートを設定・アクセスするための中央レジストリ。
- **Mail**: メールを作成・送信するための Fluent ビルダー。
- **Transport**: メール配信のバックエンド。Guren には SMTP、Resend、Memory（テスト用）のトランスポートが付属。

## 基本的な使い方

### コンテナバインディングファサードを使用

アプリケーションコンテナからファサードを作ると、`MailManager` を明示的に引き回さずにメールを送信できます。

```ts
import { createFacades } from '@guren/core'

const { Mail } = createFacades(app.container)

await Mail.to('user@example.com')
  .subject('Hello!')
  .text('Hello World!')
  .send()
```

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

### Fluent API

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

異なるユースケースに対応するため、複数のメールバックエンドを設定できます。

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
| `host` | 必須 | SMTP サーバーのホスト名 |
| `port` | `587` | SMTP サーバーのポート |
| `secure` | `false` | TLS を使用（通常はポート 465 で使用） |
| `auth.user` | - | SMTP ユーザー名 |
| `auth.pass` | - | SMTP パスワード |
| `pool` | `true` | コネクションプーリングを使用 |
| `maxConnections` | `5` | 最大プール接続数 |

**Resend Transport:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `apiKey` | 必須 | Resend API キー |

**Memory Transport（テスト用）:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `simulateFailure` | `false` | 送信失敗をシミュレート |
| `failureMessage` | - | 失敗時のエラーメッセージ |

## HTMLテンプレート

### React Emailの使用

型安全なメールテンプレートを書きたい場合は、[React Email](https://react.email/) と組み合わせられます。

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

キューを使うとメールを非同期に送信できます。queued job はワーカーが動かすアプリの container から mail manager（`mail`）を取り出し、`queue()` はその隣にバインドされた `queue` manager へディスパッチします。両方をバインドする provider があれば配線は完了です。manager がどのアプリのものか分かるよう、`createMailManager()` には provider の container を渡します。

```ts
import { ServiceProvider, createMailManager, createQueueManager, MemoryDriver } from '@guren/core'

export default class MailProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('queue', () =>
      createQueueManager({ default: 'memory', drivers: { memory: () => new MemoryDriver() } }),
    )
    this.container.singleton('mail', (container) => createMailManager(mailConfig, container))
  }
}
```

container を渡さずに作った mail manager は、既定アプリケーションの `queue` バインディングへキューします。`mail` バインディングを見つけられない job は `setMailManager()` が入れた値にフォールバックしますが、この setter は 2.23.0 で非推奨です。上のプロバイダのように、アプリのコンテナへ束縛してください。

```ts
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

使い回せるメールテンプレートとして、Mailable クラスを生成できます。

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

テストでは Memory トランスポートを使います。

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

1. **環境変数を使う**: SMTP の認証情報や API キーをハードコードしない。

2. **デフォルトの送信元を設定する**: 毎回書かずに済むよう、送信者を既定値として持たせます。

3. **大量メールはキューに乗せる**: 同期送信でリクエストを止めない。

4. **複雑なテンプレートには React Email を**: 型安全なテンプレートは保守が楽になります。

5. **Memory トランスポートでテストする**: テストから実際のメールを送らない。

6. **送信失敗を処理する**: `SendResult` を確認し、重要なメールにはリトライを組み込みます。

7. **件名は具体的に**: 明確な件名は配信率にもユーザー体験にも効きます。
