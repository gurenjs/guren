# タスクスケジューリング

Gurenは、流暢で表現力豊かな構文でスケジュールタスクを定義できる強力なタスクスケジューラーを提供します。外部のcronデーモンなしで、特定の間隔でタスクを実行するようスケジュールできます。

## 設定

スケジューラーを作成し、スケジュールタスクを定義します：

```typescript
import { createScheduler, Schedule } from '@guren/server'

const scheduler = createScheduler({
  timezone: 'Asia/Tokyo',
  checkInterval: 60000, // 毎分チェック（デフォルト）
})

// スケジュールを定義
const schedule = new Schedule()

schedule.call(async () => {
  console.log('毎分実行')
}).everyMinute()

schedule.call(async () => {
  console.log('毎日深夜0時に実行')
}).daily()

// タスクをスケジューラーに追加
for (const task of schedule.buildTasks()) {
  scheduler.addTask(task)
}

// スケジューラーを開始
scheduler.start()
```

## スケジュールの定義

### コールバックのスケジューリング

```typescript
const schedule = new Schedule()

// シンプルなコールバック
schedule.call(async () => {
  await sendDailyReport()
}).daily()

// クロージャからのパラメータ付き
const userId = 123
schedule.call(async () => {
  await processUserData(userId)
}).hourly()
```

### ジョブのスケジューリング

```typescript
import { SendNewsletterJob } from '../Jobs/SendNewsletterJob'

// スケジュールでジョブをディスパッチ
schedule.job(SendNewsletterJob, { subscriberCount: 1000 }).weekly()
```

### シェルコマンドのスケジューリング

```typescript
// シェルコマンドを実行
schedule.command('npm run cleanup').daily()

schedule.command('pg_dump mydb > backup.sql').dailyAt('03:00')
```

## スケジュール頻度オプション

### 一般的な頻度

```typescript
// 毎分
schedule.call(task).everyMinute()

// X分ごと
schedule.call(task).everyTwoMinutes()
schedule.call(task).everyThreeMinutes()
schedule.call(task).everyFourMinutes()
schedule.call(task).everyFiveMinutes()
schedule.call(task).everyTenMinutes()
schedule.call(task).everyFifteenMinutes()
schedule.call(task).everyThirtyMinutes()

// 毎時
schedule.call(task).hourly()
schedule.call(task).hourlyAt(15) // 15分に

// X時間ごと
schedule.call(task).everyTwoHours()
schedule.call(task).everyThreeHours()
schedule.call(task).everyFourHours()
schedule.call(task).everySixHours()

// 毎日
schedule.call(task).daily()           // 深夜0時
schedule.call(task).dailyAt('13:00')  // 午後1時
schedule.call(task).at('09:30')       // dailyAtのエイリアス
schedule.call(task).twiceDaily(1, 13) // 午前1時と午後1時

// 毎週
schedule.call(task).weekly()                  // 日曜日深夜0時
schedule.call(task).weeklyOn(1, '08:00')      // 月曜日午前8時

// 毎月
schedule.call(task).monthly()                 // 1日深夜0時
schedule.call(task).monthlyOn(15, '09:00')    // 15日午前9時
schedule.call(task).lastDayOfMonth('23:59')   // 月末

// 四半期ごとと毎年
schedule.call(task).quarterly()               // 1月、4月、7月、10月1日
schedule.call(task).yearly()                  // 1月1日
schedule.call(task).yearlyOn(6, 15, '12:00')  // 6月15日正午
```

### 曜日の制約

```typescript
// 特定の曜日
schedule.call(task).daily().sundays()    // 日曜日
schedule.call(task).daily().mondays()    // 月曜日
schedule.call(task).daily().tuesdays()   // 火曜日
schedule.call(task).daily().wednesdays() // 水曜日
schedule.call(task).daily().thursdays()  // 木曜日
schedule.call(task).daily().fridays()    // 金曜日
schedule.call(task).daily().saturdays()  // 土曜日

// 曜日グループ
schedule.call(task).daily().weekdays()  // 月曜日〜金曜日
schedule.call(task).daily().weekends()  // 土曜日〜日曜日
```

### カスタムCron式

```typescript
// 生のcron式を使用
schedule.call(task).cron('0 */6 * * *')  // 6時間ごと

// 標準cronフォーマット: 分 時 日 月 曜日
schedule.call(task).cron('30 9 * * 1-5')  // 平日午前9時30分
```

## タスク設定

### タスク名

```typescript
schedule.call(task)
  .daily()
  .name('daily-report')
```

### タイムゾーン

```typescript
schedule.call(task)
  .dailyAt('09:00')
  .tz('Asia/Tokyo')

// またはsetTimezoneエイリアスを使用
schedule.call(task)
  .dailyAt('09:00')
  .setTimezone('Europe/London')
```

### オーバーラップ防止

前のインスタンスがまだ実行中の場合、タスクの実行を防止：

```typescript
schedule.call(longRunningTask)
  .everyMinute()
  .preventOverlapping()

// 有効期限付き（分単位）
schedule.call(longRunningTask)
  .everyMinute()
  .withoutOverlaps(60) // 60分後にロック解除
```

### 単一サーバー実行

分散環境で、タスクが1つのサーバーでのみ実行されるようにする：

```typescript
schedule.call(task)
  .daily()
  .runOnOneServer()
```

### 条件付き実行

```typescript
// 条件がtrueの場合のみ実行
schedule.call(task)
  .daily()
  .when(() => process.env.NODE_ENV === 'production')

// 条件がtrueの場合はスキップ
schedule.call(task)
  .daily()
  .skip(() => isMaintenanceMode())
```

## ライフサイクルコールバック

### 前後処理

```typescript
schedule.call(task)
  .daily()
  .before(() => console.log('タスク開始...'))
  .after(() => console.log('タスク完了'))
```

### 成功と失敗

```typescript
schedule.call(task)
  .daily()
  .onSuccess(() => {
    console.log('タスク成功！')
  })
  .onFailure((error) => {
    console.error('タスク失敗:', error.message)
    notifyAdmin(error)
  })
```

## スケジューラーAPI

### 作成と管理

```typescript
import { createScheduler } from '@guren/server'

const scheduler = createScheduler({
  timezone: 'UTC',          // デフォルトタイムゾーン
  checkInterval: 60000,     // タスクチェック間隔（ミリ秒）
})

// タスクを追加
scheduler.addTask(task)
scheduler.schedule(taskDefinition)

// タスクを削除
scheduler.removeTask('task-name')

// タスクを取得
const allTasks = scheduler.getTasks()
const task = scheduler.getTask('task-name')
const count = scheduler.count()

// すべてのタスクをクリア
scheduler.clear()
```

### スケジューラーの実行

```typescript
// 継続的なスケジューリングを開始
scheduler.start()

// スケジューリングを停止
scheduler.stop()

// 実行中か確認
const isRunning = scheduler.getIsRunning()

// 手動tick（実行期限のタスクを1回処理）
await scheduler.tick()

// 実行せずに期限タスクを取得
const dueTasks = scheduler.getDueTasks()

// 期限タスクを手動実行
await scheduler.runDueTasks()
```

## CLIコマンド

### スケジュールタスク一覧

登録されているすべてのスケジュールタスクを表示：

```bash
bunx guren schedule:list
```

**出力：**
```
┌─────────────────┬─────────────────┬──────────────┬─────────────┐
│ 名前            │ 式              │ 次回実行     │ タイムゾーン│
├─────────────────┼─────────────────┼──────────────┼─────────────┤
│ daily-report    │ 0 0 * * *       │ 6時間後      │ UTC         │
│ cleanup         │ 0 3 * * *       │ 9時間後      │ UTC         │
│ send-newsletter │ 0 0 * * 0       │ 3日後        │ Asia/Tokyo  │
└─────────────────┴─────────────────┴──────────────┴─────────────┘
```

### スケジュールタスク実行

期限タスクを手動でトリガー：

```bash
# すべての期限タスクを実行
bunx guren schedule:run

# 名前で特定のタスクを実行
bunx guren schedule:run --task daily-report

# 強制実行（スケジュールを無視）
bunx guren schedule:run --force
```

## 統合例

### アプリケーションブートストラップ

```typescript
// app/Console/Kernel.ts
import { Schedule, createScheduler } from '@guren/server'
import { SendDailyReportJob } from '../Jobs/SendDailyReportJob'
import { CleanupTempFilesJob } from '../Jobs/CleanupTempFilesJob'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()

  // 午前9時に日次レポート
  schedule.job(SendDailyReportJob, {})
    .dailyAt('09:00')
    .tz('Asia/Tokyo')
    .name('daily-report')
    .onFailure((error) => {
      console.error('日次レポート失敗:', error)
    })

  // 6時間ごとに一時ファイルをクリーンアップ
  schedule.call(async () => {
    await CleanupTempFilesJob.dispatch({})
  })
    .everySixHours()
    .name('cleanup-temp')
    .preventOverlapping()

  // 午前3時にデータベースバックアップ
  schedule.command('pg_dump mydb > /backups/db-$(date +%Y%m%d).sql')
    .dailyAt('03:00')
    .name('db-backup')

  return schedule
}

// メインアプリファイルで
import { scheduleTasksKernel } from './Console/Kernel'

const schedule = scheduleTasksKernel()
const scheduler = createScheduler({ timezone: 'Asia/Tokyo' })

for (const task of schedule.buildTasks()) {
  scheduler.addTask(task)
}

scheduler.start()
```

## ベストプラクティス

1. **タスクに名前を付ける** - デバッグと監視が容易になります
2. **適切なタイムゾーンを使用** - 時間に敏感なタスクにはタイムゾーンを明示的に設定
3. **オーバーラップを防止** - 同時実行すべきでない長時間実行タスク用
4. **失敗ハンドラーを追加** - スケジュールタスクが失敗した際に通知を受ける
5. **重いタスクにはジョブを使用** - スケジューラーで直接実行せずジョブをキューイング
6. **ローカルでテスト** - `schedule:run --force`でタスク実行をテスト
