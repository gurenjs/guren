# タスクスケジューリングガイド

Guren では、スケジュールタスクをアプリケーション内の Fluent API で定義します。cronのエントリを複数管理する代わりに、タスクのスケジュール全体をコードに書けます。

推奨パターン: `@guren/core` から scheduling API をインポートし、スケジュールは一箇所で登録します。各機能のコードでは、実行されるジョブやコマンドの実装だけを書きます。

## コアコンセプト

- **Scheduler**: スケジュールされたタスクを管理し、適切なタイミングで実行する。
- **Schedule**: Fluent API でタスクを定義するビルダー。
- **ScheduledTask**: スケジュールと設定を持つ個別のタスク。
- **Cron Expression**: タスクの実行タイミングを定義する標準的なcron構文。

## 基本的な使い方

### クイックスタート

```ts
import { Scheduler } from '@guren/core'

const scheduler = new Scheduler()

scheduler.schedule((schedule) => {
  // 毎日午前3時にコールバックを実行
  schedule.call(async () => {
    await cleanupOldSessions()
  }).daily().at('03:00').name('cleanup-sessions')
})

scheduler.start()
```

### スケジューラーの実行

アプリケーションのブートストラップでスケジューラーを起動します。

```ts
// app.ts
import { Scheduler } from '@guren/core'

const scheduler = new Scheduler({
  timezone: 'Asia/Tokyo',
  checkInterval: 60000, // 60秒ごとにチェック
  logger: console.log,
})

// スケジュールを定義
scheduler.schedule((schedule) => {
  schedule.call(() => console.log('Hello!')).everyMinute()
})

// アプリ起動時に開始
scheduler.start()

// シャットダウン時に停止
process.on('SIGTERM', () => {
  scheduler.stop()
})
```

### サーバーレスランタイムでの実行

`scheduler.start()` は常駐プロセスを前提にしますが、Cloudflare Workers にも AWS Lambda にも常駐プロセスはありません。これらの環境では、プラットフォーム側のスケジューラが時計を刻み、アプリはタスクを登録するだけです。

- **Cloudflare Workers**: `guren cloudflare:build` が生成するワーカーが `scheduled` ハンドラを export し、`wrangler.jsonc` の `triggers.crons` がそれを駆動します。[Cloudflare Workers へのデプロイ](./cloudflare.md#スケジュールタスク)を参照してください。
- **AWS Lambda**: `@guren/core/lambda` の `createScheduleHandler(scheduler)` を EventBridge ルールに接続します。[サーバーレス](./serverless.md)を参照してください。

起動のたびに、その時点で実行時刻を迎えているタスクだけが動きます。そのためプラットフォームのトリガーは、いちばん細かいタスクと同じかそれより細かい頻度にしてください。また `preventOverlapping()` と `onOneServer()` はタスク上のメモリ内フラグなので、プロセスが常駐しないランタイムでは起動をまたいで効きません。`schedule.command()` は `node:child_process` 経由でシェルに任せるため、Workers では動きません。そちらでは `schedule.call()` か `schedule.job()` を使ってください。

## スケジュールの定義

### コールバック

```ts
scheduler.schedule((schedule) => {
  schedule.call(async () => {
    // タスクロジック
    await sendDailyReports()
  }).daily().at('09:00')
})
```

### ジョブ

キュージョブをスケジュールでディスパッチします。

```ts
import { SendWeeklyDigestJob } from '@/app/Jobs/SendWeeklyDigestJob'

scheduler.schedule((schedule) => {
  schedule.job(SendWeeklyDigestJob, { userId: 'all' })
    .weekly()
    .sundays()
    .at('09:00')
})
```

### シェルコマンド

```ts
scheduler.schedule((schedule) => {
  schedule.command('bunx guren db:backup')
    .daily()
    .at('02:00')
    .name('database-backup')
})
```

## 実行頻度オプション

### 分単位

```ts
schedule.call(task).everyMinute()        // 毎分
schedule.call(task).everyTwoMinutes()    // 2分ごと
schedule.call(task).everyThreeMinutes()  // 3分ごと
schedule.call(task).everyFourMinutes()   // 4分ごと
schedule.call(task).everyFiveMinutes()   // 5分ごと
schedule.call(task).everyTenMinutes()    // 10分ごと
schedule.call(task).everyFifteenMinutes()// 15分ごと
schedule.call(task).everyThirtyMinutes() // 30分ごと
```

### 時間単位

```ts
schedule.call(task).hourly()             // 毎時00分
schedule.call(task).hourlyAt(15)         // 毎時15分
schedule.call(task).everyTwoHours()      // 2時間ごと
schedule.call(task).everyThreeHours()    // 3時間ごと
schedule.call(task).everyFourHours()     // 4時間ごと
schedule.call(task).everySixHours()      // 6時間ごと
```

### 日単位

```ts
schedule.call(task).daily()              // 毎日0時
schedule.call(task).dailyAt('13:00')     // 毎日13時
schedule.call(task).at('13:00')          // dailyAtのエイリアス
schedule.call(task).twiceDaily(1, 13)    // 1時と13時
```

### 週単位

```ts
schedule.call(task).weekly()                   // 毎週日曜0時
schedule.call(task).weeklyOn(1, '08:00')       // 毎週月曜8時

// 曜日のショートカット
schedule.call(task).daily().sundays()
schedule.call(task).daily().mondays()
schedule.call(task).daily().tuesdays()
schedule.call(task).daily().wednesdays()
schedule.call(task).daily().thursdays()
schedule.call(task).daily().fridays()
schedule.call(task).daily().saturdays()

// 平日と週末
schedule.call(task).daily().weekdays()         // 月曜〜金曜
schedule.call(task).daily().weekends()         // 土曜〜日曜
```

### 月単位と年単位

```ts
schedule.call(task).monthly()                  // 毎月1日0時
schedule.call(task).monthlyOn(15, '09:00')     // 毎月15日9時
schedule.call(task).lastDayOfMonth('18:00')    // 月末18時
schedule.call(task).quarterly()                // 1月、4月、7月、10月1日
schedule.call(task).yearly()                   // 1月1日0時
schedule.call(task).yearlyOn(6, 15, '12:00')   // 6月15日12時
```

### カスタムCron

```ts
// 標準cronフォーマット: 分 時 日 月 曜日
schedule.call(task).cron('0 */2 * * *')        // 2時間ごと
schedule.call(task).cron('30 9 * * 1-5')       // 平日9:30
schedule.call(task).cron('0 0 1,15 * *')       // 1日と15日の0時
```

## タスク設定

### タスク名

```ts
schedule.call(sendReports)
  .daily()
  .name('send-daily-reports')  // タスクの一意識別子
```

### タイムゾーン

```ts
schedule.call(task)
  .daily()
  .at('09:00')
  .tz('Asia/Tokyo')            // 東京時間の9時に実行

// またはsetTimezoneを使用
schedule.call(task)
  .daily()
  .setTimezone('America/New_York')
```

### 重複実行の防止

前のインスタンスがまだ実行中の場合、タスクの実行をスキップします。

```ts
schedule.call(longRunningTask)
  .everyMinute()
  .preventOverlapping()        // 前回の実行が終わっていなければスキップ

// 有効期限付き（10分後に自動アンロック）
schedule.call(task)
  .everyMinute()
  .preventOverlapping(600000)  // ミリ秒で10分
```

### 単一サーバーでの実行

複数サーバー構成で、1台のサーバーだけがタスクを実行するようにします。

```ts
schedule.call(task)
  .daily()
  .runOnOneServer()            // 分散ロック（Redis）が必要
```

### 条件付き実行

```ts
// 条件がtrueの場合のみ実行
schedule.call(task)
  .daily()
  .when(() => process.env.NODE_ENV === 'production')

// 条件がtrueの場合はスキップ
schedule.call(task)
  .daily()
  .skip(() => isMaintenanceMode())
```

### ライフサイクルフック

```ts
schedule.call(sendEmails)
  .daily()
  .at('09:00')
  .before(() => console.log('メール送信開始...'))
  .after(() => console.log('メール送信完了'))
  .onSuccess(() => metrics.increment('emails.sent'))
  .onFailure((error) => {
    alerting.notify('メール送信失敗', error)
  })
```

## スケジューラーAPI

```ts
const scheduler = new Scheduler()

// タスクを定義
scheduler.schedule((schedule) => { ... })

// ビルド済みタスクを追加
scheduler.addTask(scheduledTask)

// 開始/停止
scheduler.start()
scheduler.stop()

// ステータス確認
scheduler.getIsRunning()

// タスクを取得
scheduler.getTasks()                    // 全タスク
scheduler.getDueTasks()                 // 現在実行予定のタスク
scheduler.getTask('task-name')          // 名前でタスクを取得
scheduler.count()                       // タスク数

// タスク管理
scheduler.removeTask('task-name')       // 名前で削除
scheduler.clear()                       // 全タスク削除

// 手動実行
await scheduler.runDueTasks()           // 実行予定の全タスクを今すぐ実行
```

## CLI統合

常駐するスケジューラーはアプリケーションの中で動きます(前述の`scheduler.start()`)。
CLIが担うのは残りの半分、登録内容の確認と、プロセスの外からの実行です。後者は
システムのcronやプラットフォームのトリガーから呼びます。

```bash
# スケジュールされたタスクを一覧
bunx guren schedule:list
bunx guren schedule:list --json

# 実行時刻を迎えたタスクを実行
bunx guren schedule:run

# 特定のタスクを時刻に関係なく即座に実行
bunx guren schedule:run --task cleanup-sessions --force
```

### CLIから見えるようにする

`schedule:list`と`schedule:run`はアプリケーションをbootしません。スケジュール
カーネルを直接読み込むだけで、`app/Console/Kernel.ts`(小文字版と`src/`版も含む)、
あるいは`--kernel`で渡したパスを探します。それ以外の場所で宣言したタスクは、
`scheduler.start()`の下で問題なく動いていても、この2つのコマンドからは見えません。

認識されるエクスポートの形は2つで、それぞれに命名規約があります。

**レジストラ**は多くのアプリケーションコードが既に持っている形です。プロバイダー
がスケジューラーを構築して渡し、CLIは自前のスケジューラーを渡します。

```ts
// app/Console/Kernel.ts
import type { Scheduler } from '@guren/core'

export function registerSchedules(scheduler: Scheduler): void {
  scheduler.schedule((schedule) => {
    schedule.call(warmCache).hourly().name('warm-cache')
  })
}
```

名前は`register…Schedules`(`registerSchedules`、`registerBillingSchedules`など)
にするか、デフォルトエクスポートにします。1つのカーネルが複数エクスポートしても
よく、そのすべてが同じスケジューラーを受け取ります。この規約があるおかげで、CLIは
ファイルがたまたまエクスポートしているヘルパーまで呼ばずに済みます。規約から外れた
名前のレジストラは、黙って無視されるのではなく「認識できない」と報告されます。

**カーネルファクトリ**は引数を取らず、構築した`Schedule`を返します。
`scheduleTasksKernel`、`schedule`、`defineSchedule`、またはデフォルトエクスポート
として認識され、`bunx guren add schedule`が生成するのはこの形です。

```ts
// app/Console/Kernel.ts
import { Schedule } from '@guren/core'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()
  schedule.call(warmCache).hourly().name('warm-cache')
  return schedule
}
```

ファクトリはタスクを宣言するだけで、それ自体は何も実行しません。プロバイダーが
バインドするスケジューラーに渡してください。

```ts
for (const task of scheduleTasksKernel().buildTasks()) scheduler.addTask(task)
```

アプリケーションコードではレジストラを推奨します。このガイドの他の箇所で説明して
いる`Scheduler` APIをそのまま使えますし、配線をもう一度書かなくてもタスクが実行中
のスケジューラーに届きます。

どちらの形でも、サービスの解決はカーネル構築時ではなくタスクのコールバック内で
行ってください。CLIはアプリをbootせずにこのファイルを読むため、構築時のコンテナ
参照には解決先がありません。

```ts
schedule.call(() => getContainer().make<SessionManager>('session').pruneExpired()).hourly()
```

カーネルがあるのにどちらの形にも一致しない場合、あるいは読み込み中に例外を投げた
場合は、その旨を報告して非ゼロで終了します。まだ何もスケジュールしていないアプリ
とは、別の状態として扱います。

## テスト

```ts
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Scheduler, Schedule } from '@guren/core'

describe('Scheduling', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler()
  })

  afterEach(() => {
    scheduler.stop()
  })

  test('日次タスクをスケジュールする', () => {
    scheduler.schedule((schedule) => {
      schedule.call(() => {}).daily().at('09:00').name('test-task')
    })

    expect(scheduler.count()).toBe(1)
    expect(scheduler.getTask('test-task')).toBeDefined()
  })

  test('実行予定のタスクを識別する', () => {
    const mockTask = mock(() => {})

    scheduler.schedule((schedule) => {
      schedule.call(mockTask).everyMinute()
    })

    const dueTasks = scheduler.getDueTasks(new Date())
    expect(dueTasks.length).toBeGreaterThan(0)
  })

  test('実行予定のタスクを実行する', async () => {
    let executed = false

    scheduler.schedule((schedule) => {
      schedule.call(() => { executed = true }).everyMinute()
    })

    await scheduler.runDueTasks()

    expect(executed).toBe(true)
  })

  test('when条件を尊重する', async () => {
    let executed = false

    scheduler.schedule((schedule) => {
      schedule.call(() => { executed = true })
        .everyMinute()
        .when(() => false)  // 実行しない
    })

    await scheduler.runDueTasks()

    expect(executed).toBe(false)
  })
})
```

## ベストプラクティス

1. **タスクに名前を付ける**: デバッグと管理を容易にするため、常に`.name()`を使用。

2. **適切な頻度を使用**: 必要以上に頻繁にタスクをスケジュールしない。

3. **タイムゾーンを明示的に設定**: 時間に敏感なタスクには曖昧さを避けるためタイムゾーンを設定。

4. **長いタスクには重複防止**: インターバルより長くかかる可能性のあるタスクには`.preventOverlapping()`を使用。

5. **失敗を適切に処理**: `.onFailure()`でエラーをログし、アラートを送信。

6. **スケジュールをテスト**: タスクスケジューリングロジックを検証するテストを書く。

7. **タスク実行を監視**: タスクの実行をログし、成功/失敗のメトリクスを追跡。

8. **重い処理にはジョブを使用**: 重いタスクを直接スケジューラーで実行せず、ジョブをディスパッチ。
