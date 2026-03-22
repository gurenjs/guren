# ロギングガイド

GurenはRFC 5424に準拠したログレベル、複数のチャンネル、コンテキスト付きロギングをサポートする柔軟なロギングシステムを提供します。

## コアコンセプト

- **LogManager** – ロギングチャンネルを管理する中央ハブ。
- **Logger** – コンテキストサポート付きでログエントリを書き込むインスタンス。
- **LogChannel** – ログエントリの出力先（コンソール、ファイルなど）。
- **LogLevel** – RFC 5424に準拠した重大度レベル（emergency、alert、critical、error、warning、notice、info、debug）。

## 基本的な使い方

### ファサードを使用（推奨）

`LogFacade` を使うと、コンテナから `LogManager` を遅延解決してシンプルにログ出力できます:

```ts
import { LogFacade as Log } from '@guren/core'

Log.info('アプリケーションが起動しました')
Log.error('問題が発生しました', { error: '接続に失敗しました' })
Log.channel('file').warning('ファイルにのみ記録')
```

### クイックスタート

`LogManager` を直接インスタンス化して使うこともできます:

```ts
import { LogManager } from '@guren/core'

const log = new LogManager({
  default: 'console',
  channels: {
    console: { driver: 'console', level: 'debug' },
  },
})

log.info('アプリケーションが起動しました')
log.error('問題が発生しました', { error: '接続に失敗しました' })
```

### ログレベル

GurenはRFC 5424の重大度レベルをサポート（最も重大なものから）：

```ts
log.emergency('システムが使用不能')
log.alert('即時対応が必要')
log.critical('重大な状態')
log.error('エラー状態')
log.warning('警告状態')  // または log.warn()
log.notice('正常だが重要な状態')
log.info('情報メッセージ')
log.debug('デバッグレベルのメッセージ')
```

### コンテキスト付きロギング

```ts
// 個別のログエントリにコンテキストを追加
log.info('ユーザーがログイン', { userId: 123, ip: '192.168.1.1' })

// 永続的なコンテキストを持つロガーを作成
const requestLog = log.withContext({ requestId: 'abc-123' })
requestLog.info('リクエスト処理中')    // requestIdを含む
requestLog.info('リクエスト完了')     // requestIdを含む

// 子ロガーを作成
const userLog = requestLog.child({ userId: 456 })
userLog.info('ユーザーアクション')  // requestIdとuserIdを含む
```

## チャンネル

### コンソールチャンネル

色とフォーマット付きでコンソールに出力：

```ts
const log = new LogManager({
  default: 'console',
  channels: {
    console: {
      driver: 'console',
      level: 'debug',          // ログ出力の最小レベル
      colors: true,            // ANSIカラーを有効化
      timestamps: true,        // タイムスタンプを含める
      format: 'text',          // 'text' または 'json'
    },
  },
})
```

### ファイルチャンネル

単一ファイルにログを書き込み：

```ts
const log = new LogManager({
  default: 'file',
  channels: {
    file: {
      driver: 'file',
      path: './storage/logs/app.log',
      level: 'info',
      format: 'json',  // 'text' または 'json'
    },
  },
})
```

### デイリーファイルチャンネル

自動クリーンアップ付きで毎日ログファイルをローテーション：

```ts
const log = new LogManager({
  default: 'daily',
  channels: {
    daily: {
      driver: 'daily',
      path: './storage/logs/app.log',
      days: 14,        // 14日間ログを保持
      level: 'info',
      format: 'json',
    },
  },
})
```

ファイル名には日付サフィックスが付きます：`app-2024-01-15.log`

### スタックチャンネル

複数のチャンネルを組み合わせ：

```ts
const log = new LogManager({
  default: 'stack',
  channels: {
    console: { driver: 'console', level: 'debug' },
    file: { driver: 'daily', path: './storage/logs/app.log', days: 14 },
    stack: {
      driver: 'stack',
      channels: ['console', 'file'],  // 両方に書き込み
    },
  },
})
```

## 複数チャンネルの使用

### チャンネルの切り替え

```ts
// デフォルトチャンネルを使用
log.info('デフォルトを使用')

// 特定のチャンネルを使用
log.channel('console').debug('デバッグ情報')
log.channel('file').error('ファイルのみに記録')
```

### 一時的なスタック

```ts
// 一時的なスタックを作成
log.stack(['console', 'file']).critical('重大なエラー！')
```

## 設定

### 完全な設定例

```ts
import { LogManager } from '@guren/core'

const log = new LogManager({
  default: 'stack',
  channels: {
    // 開発用コンソール
    console: {
      driver: 'console',
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      colors: true,
      timestamps: true,
      format: 'text',
    },

    // 本番用の日次ローテーションファイル
    daily: {
      driver: 'daily',
      path: './storage/logs/app.log',
      level: 'info',
      days: 30,
      format: 'json',
    },

    // エラー専用ログ
    errors: {
      driver: 'daily',
      path: './storage/logs/errors.log',
      level: 'error',
      days: 90,
      format: 'json',
    },

    // デフォルトロギング用スタック
    stack: {
      driver: 'stack',
      channels: ['console', 'daily'],
    },

    // 重大アラート
    critical: {
      driver: 'stack',
      channels: ['console', 'daily', 'errors'],
    },
  },
})
```

## グローバルロガー

### グローバルロガーのセットアップ

```ts
import { setLogManager, getLogManager, LogManager } from '@guren/core'

// ブートストラップファイルで
const log = new LogManager({
  default: 'stack',
  channels: { /* ... */ },
})

setLogManager(log)

// アプリケーションのどこでも
const log = getLogManager()
log.info('グローバルロガーを使用')
```

## カスタムチャンネル

### カスタムチャンネルの作成

```ts
import type { LogChannel, LogEntry } from '@guren/core'

class SlackChannel implements LogChannel {
  constructor(private webhookUrl: string) {}

  async log(entry: LogEntry): Promise<void> {
    if (entry.level !== 'critical' && entry.level !== 'emergency') {
      return // critical/emergencyのみSlackに送信
    }

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${entry.level.toUpperCase()}] ${entry.message}`,
        attachments: [{
          fields: Object.entries(entry.context).map(([k, v]) => ({
            title: k,
            value: String(v),
            short: true,
          })),
        }],
      }),
    })
  }
}
```

### カスタムドライバーの登録

```ts
const log = new LogManager({
  default: 'stack',
  channels: {
    slack: { driver: 'slack', webhookUrl: process.env.SLACK_WEBHOOK },
    stack: { driver: 'stack', channels: ['console', 'slack'] },
  },
})

log.registerDriver('slack', (config) => {
  return new SlackChannel(config.webhookUrl as string)
})
```

## リクエストロギング

### ミドルウェアの例

```ts
import { defineMiddleware } from '@guren/core'
import { getLogManager } from '@guren/core'

export const requestLogging = defineMiddleware(async (c, next) => {
  const log = getLogManager()
  const requestId = crypto.randomUUID()
  const requestLog = log.withContext({
    requestId,
    method: c.req.method,
    path: c.req.path,
  })

  const start = Date.now()
  requestLog.info('リクエスト開始')

  // ハンドラーで使用するためコンテキストにロガーを保存
  c.set('log', requestLog)

  try {
    await next()

    requestLog.info('リクエスト完了', {
      status: c.res.status,
      duration: Date.now() - start,
    })
  } catch (error) {
    requestLog.error('リクエスト失敗', {
      error: error instanceof Error ? error.message : '不明なエラー',
      duration: Date.now() - start,
    })
    throw error
  }
})
```

## テスト

```ts
import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { LogManager, Logger, LOG_LEVEL_PRIORITY } from '@guren/core'
import type { LogChannel, LogEntry } from '@guren/core'

// テスト用メモリチャンネルを作成
class MemoryChannel implements LogChannel {
  entries: LogEntry[] = []

  log(entry: LogEntry): void {
    this.entries.push(entry)
  }

  clear(): void {
    this.entries = []
  }
}

describe('ロギング', () => {
  let memoryChannel: MemoryChannel
  let log: LogManager

  beforeEach(() => {
    memoryChannel = new MemoryChannel()
    log = new LogManager({
      default: 'memory',
      channels: {
        memory: { driver: 'memory' },
      },
    })
    log.registerDriver('memory', () => memoryChannel)
  })

  test('異なるレベルでログを記録する', () => {
    log.info('情報メッセージ')
    log.error('エラーメッセージ')

    expect(memoryChannel.entries).toHaveLength(2)
    expect(memoryChannel.entries[0].level).toBe('info')
    expect(memoryChannel.entries[1].level).toBe('error')
  })

  test('ログエントリにコンテキストを含める', () => {
    log.info('ユーザーアクション', { userId: 123 })

    expect(memoryChannel.entries[0].context).toEqual({ userId: 123 })
  })

  test('withContextが永続的なコンテキストを追加する', () => {
    const requestLog = log.withContext({ requestId: 'abc' })
    requestLog.info('最初')
    requestLog.info('2番目', { extra: 'data' })

    expect(memoryChannel.entries[0].context).toEqual({ requestId: 'abc' })
    expect(memoryChannel.entries[1].context).toEqual({ requestId: 'abc', extra: 'data' })
  })
})
```

## ログ出力フォーマット

### テキストフォーマット

```
[2024-01-15T10:30:00.000Z] INFO      ユーザーがログイン {"userId":123,"ip":"192.168.1.1"}
[2024-01-15T10:30:01.000Z] ERROR     データベース接続失敗 {"error":"ECONNREFUSED"}
```

### JSONフォーマット

```json
{"timestamp":"2024-01-15T10:30:00.000Z","level":"info","message":"ユーザーがログイン","userId":123,"ip":"192.168.1.1"}
{"timestamp":"2024-01-15T10:30:01.000Z","level":"error","message":"データベース接続失敗","error":"ECONNREFUSED"}
```

## ベストプラクティス

1. **適切なログレベルを使用**: すべてをerrorとして記録しない；開発情報にはdebugを使用。

2. **コンテキストを含める**: デバッグのため常に関連するコンテキスト（ユーザーID、リクエストIDなど）を追加。

3. **構造化ロギングを使用**: 本番環境ではJSONフォーマットの方が解析・検索が容易。

4. **ログファイルをローテーション**: ディスク容量の問題を防ぐためdailyドライバーを使用。

5. **本番環境ではレベルでフィルタリング**: 本番環境ではコンソールを'info'以上に設定。

6. **コンテキスト付きロガーを作成**: リクエストスコープのロギングには`withContext()`を使用。

7. **機密データをログに記録しない**: パスワード、トークン、個人情報は決してログに記録しない。

8. **シャットダウン時にチャンネルを閉じる**: 保留中の書き込みをフラッシュするため`log.close()`を呼び出す。
