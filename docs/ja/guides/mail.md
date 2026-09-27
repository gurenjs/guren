# メールガイド

Guren ではメールの送信を Fluent API で書け、配信に使うトランスポートを複数使い分けられます。キューと組み合わせれば非同期に送れ、HTML テンプレートや添付ファイルも扱えます。

標準的な書き方では、mail の API を `@guren/core` からインポートし、mail manager の設定は `config/mail.ts` にまとめます。コントローラーでは、メールを組み立てて送ることだけを書きます。

## コアコンセプト

- **MailManager**: メールトランスポートを設定し、取り出すための中央レジストリです。
- **Mail**: メールを組み立てて送信するための Fluent ビルダーです。
- **Transport**: メールを配信するバックエンドです。Guren には SMTP、Resend、Log（開発用）、Memory（テスト用）のトランスポートが付属しています。

## 基本的な使い方

### コンテナバインディングファサードを使用

アプリケーションコンテナからファサードを作っておけば、`MailManager` を引数で持ち回らなくてもメールを送れます。

```ts
import { createFacades } from '@guren/core'

const { Mail } = createFacades(app.container)

await Mail.to('user@example.com')
  .subject('Hello!')
  .text('Hello World!')
  .send()
```

### 直接インスタンス化

`MailManager` を直接作ることもできます。

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

送信に使うトランスポートは `config/mail.ts` にすべて宣言しておき、既定で使うものを環境変数で選びます。`bunx guren add mail` を実行すると、`log`、`memory`、`smtp` の 3 つを宣言したこのファイルが生成されます。下の例の `resend` は、手で追加したトランスポートです。

```ts
// config/mail.ts
import { defineMailConfig } from '@guren/core'

export default defineMailConfig((env) => {
  const transports = {
    log: { driver: 'log' },
    memory: { driver: 'memory' },
    smtp: {
      driver: 'smtp',
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    },
    resend: { driver: 'resend', apiKey: env.RESEND_API_KEY ?? '' },
  }

  // manager はどんな名前も受け付け、最初の送信で例外を投げる。それがキュージョブの中のこともある。
  if (!Object.hasOwn(transports, env.MAIL_MAILER)) {
    throw new Error(
      `MAIL_MAILER="${env.MAIL_MAILER}" is not a declared transport. Declare it in config/mail.ts or use one of: ${Object.keys(transports).join(', ')}.`,
    )
  }

  return {
    default: env.MAIL_MAILER,
    from: { email: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME },
    transports,
  }
})
```

```ts
// src/app.ts
import { createApp } from '@guren/core'
import env from '../config/env.js'
import mail from '../config/mail.js'

const app = createApp({ env, config: [mail] })
```

コールバックが読むキーは、すべて `config/env.ts` で宣言しておく必要があります。`guren add mail` が宣言するのは `MAIL_MAILER`、`MAIL_FROM_ADDRESS`、`MAIL_FROM_NAME` と `SMTP_*` です。上の `resend` のように自分で足したトランスポートのキーは、手で宣言してください（`RESEND_API_KEY: Env.string().secret().optional()`）。変数の宣言方法は[設定ガイド](./configuration.md)で説明しています。

`MAIL_MAILER=log` にすると、送ったメールがサーバーの出力に書き出されるので、開発中はこれで足ります。本番ではコードを変えずに、`MAIL_MAILER` を `smtp` や `resend` に切り替えてください。メールごとにトランスポートを指定することもできます。

```ts
// デフォルトトランスポートを使用
await mail(mailManager).to('user@example.com').subject('Test').text('Hello').send()

// 特定のトランスポートを使用
await mail(mailManager)
  .via('resend')
  .to('user@example.com')
  .subject('Via Resend')
  .text('Hello')
  .send()
```

メールをサービスプロバイダで設定しているアプリも、そのまま動きます。詳しくは[サービスプロバイダを使うアプリ](./configuration.md#サービスプロバイダを使うアプリ)を参照してください。

### トランスポートオプション

**SMTP Transport:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `host` | 必須 | SMTP サーバーのホスト名 |
| `port` | `587` | SMTP サーバーのポート |
| `secure` | `false` | TLS を使う（通常はポート 465 と組み合わせる） |
| `auth.user` | - | SMTP ユーザー名 |
| `auth.pass` | - | SMTP パスワード |
| `pool` | `true` | コネクションプーリングを使う |
| `maxConnections` | `5` | プールの最大接続数 |

**Resend Transport:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `apiKey` | 必須 | Resend API キー |

**Log Transport（開発用）:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `logger` | `console.log` | 送信の代わりに、整形したメッセージを受け取る関数 |

**Memory Transport（テスト用）:**
| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `simulateFailure` | `false` | 送信の失敗を再現する |
| `failureMessage` | - | 失敗させたときのエラーメッセージ |

## HTMLテンプレート

### React Emailの使用

型安全なメールテンプレートを書きたい場合は、[React Email](https://react.email/) と組み合わせて使えます。

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

キューを使うと、メールを非同期に送れます。キューに入ったジョブは、ワーカーが動かしているアプリのコンテナから mail manager（`mail`）を取り出します。`queue()` は、同じコンテナにバインドされた `queue` manager を通してジョブをディスパッチします。必要な配線は、`createApp()` に 2 つの定義を並べることだけです。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import env from '../config/env.js'
import mail from '../config/mail.js'
import queue from '../config/queue.js'

const app = createApp({ env, config: [mail, queue] })
```

`defineMailConfig` は、manager を解決するコンテナを渡して manager を作ります。そのため、manager は自分がどのアプリに属しているかを知っています。`config/queue.ts` の書き方は[キューガイド](./queue.md)を参照してください。`QUEUE_CONNECTION=sync` ではジョブがその場で実行されるので、送信をリクエストの処理から切り離したい場合は、ワーカーが処理するドライバを選んでください。

コンテナを渡さずに `createMailManager(config)` で作った mail manager は、既定のアプリケーションの `queue` バインディングにジョブを入れます。`mail` バインディングが見つからないジョブは `setMailManager()` で設定した値を使いますが、この setter は 2.23.0 で非推奨になりました。`config/mail.ts` と同じように、manager はアプリのコンテナに束縛してください。

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

何度も使うメールは、Mailable クラスとして生成しておけます。

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

## コンテナとの統合

`config/mail.ts` は、mail manager を `mail` という名前のシングルトンとしてバインドします。そのため、コンテナから解決して使えます。

```ts
// app.container、または provider 内の this.container から取得

const mailManager = container.make('mail') // MailManager
```

### `container.fake()` を使ったテスト

テストで mail manager を差し替えると、実際には送信せずに、送ろうとしたメッセージを捕まえられます。

```ts
// app.container、または provider 内の this.container から取得
import { MailManager, MemoryTransport } from '@guren/core'

test('sends welcome email on registration', async () => {
  const memoryTransport = new MemoryTransport()
  const fakeMail = new MailManager({
    default: 'memory',
    from: { email: 'test@example.com' },
  })
  fakeMail.registerTransport('memory', () => memoryTransport)

  using _ = container.fake('mail', fakeMail)

  // テスト対象のコードを実行する。ファサードやコンテナ経由で送ったメールは
  // すべて memoryTransport に捕捉される
  await registerUser({ email: 'new@example.com' })

  const sent = memoryTransport.getSentMessages()
  expect(sent).toHaveLength(1)
  expect(sent[0].to[0].email).toBe('new@example.com')
})
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

1. **環境変数を使う。** SMTP の認証情報や API キーはハードコードせず、`config/env.ts` で宣言して `config/mail.ts` で読みます。

2. **デフォルトの送信元を設定する。** 送信者を既定値として持たせておけば、毎回書かずに済みます。

3. **大量のメールはキューで送る。** 同期で送ると、送信が終わるまでリクエストが止まってしまいます。

4. **複雑なテンプレートには React Email を使う。** 型安全なテンプレートは保守が楽です。

5. **Memory トランスポートでテストする。** テストから実際のメールを送らないようにします。

6. **送信の失敗を処理する。** `SendResult` を確認し、重要なメールにはリトライを組み込みます。

7. **件名は具体的に書く。** 何のメールかがわかる件名は、配信率にもユーザー体験にも効きます。
