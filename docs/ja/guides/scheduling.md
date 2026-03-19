# タスクスケジューリングガイド

Gurenはアプリケーション内でスケジュールタスクを定義するための流暢なAPIを提供します。複数のcronエントリを管理する代わりに、コード内でタスクスケジュール全体を定義できます。

## コアコンセプト

- **Scheduler** – スケジュールされたタスクを管理し、適切なタイミングで実行する。
- **Schedule** – 流暢なAPIでタスクを定義するビルダー。
- **ScheduledTask** – スケジュールと設定を持つ個別のタスク。
- **Cron Expression** – タスクの実行タイミングを定義する標準的なcron構文。

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

アプリケーションのブートストラップでスケジューラーを起動：

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

キュージョブをスケジュールでディスパッチ：

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

前のインスタンスがまだ実行中の場合、タスクの実行をスキップ：

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

マルチサーバー環境で、1台のサーバーでのみタスクを実行：

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

コマンドラインからスケジューラーを実行：

```bash
# スケジューラーを開始
bunx guren schedule:work

# カスタムタイムゾーンで開始
bunx guren schedule:work --timezone=Asia/Tokyo

# スケジュールされたタスクを一覧
bunx guren schedule:list

# 特定のタスクを即座に実行
bunx guren schedule:run cleanup-sessions
```

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
