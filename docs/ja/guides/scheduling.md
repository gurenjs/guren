# タスクスケジューリングガイド

Guren では、定期実行するタスクをアプリケーションの中で Fluent API を使って定義します。cron のエントリをいくつも管理しなくても、タスクのスケジュールをすべてコードに書けます。

おすすめの書き方は、`@guren/core` から scheduling API を import し、スケジュールの登録を 1 か所にまとめることです。各機能のコードには、スケジュールから実行するジョブやコマンドの実装だけを書きます。

## コアコンセプト

- **Scheduler**: スケジュールされたタスクを管理し、決まったタイミングで実行する。
- **Schedule**: Fluent API でタスクを定義するためのビルダー。
- **ScheduledTask**: スケジュールと設定を持つ、1 つひとつのタスク。
- **Cron Expression**: タスクをいつ実行するかを表す、標準的な cron の構文。

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

スケジューラーは、アプリケーションの起動処理の中で開始します。

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

`scheduler.start()` を呼ぶと、その場で一度 tick が走ります。そのあと tick が続くのは、アプリサーバーのように別の仕組みが動かし続けているプロセスの中だけです。`scheduler.start()` を呼ぶだけの単体スクリプトでは、その時点で実行時刻を迎えたタスクを動かしたら、次の tick を待たずにプロセスが終了します。実行時刻を迎えたタスクをプロセスの外から実行したい場合は、cron から `bunx guren schedule:run` を呼び出してください。このコマンドは、スケジュールカーネルに登録したタスクを読み込んで実行します。詳しくは[CLIから見えるようにする](#cliから見えるようにする)を参照してください。

### サーバーレスランタイムでの実行

`scheduler.start()` は常駐するプロセスを必要としますが、Cloudflare Workers にも AWS Lambda にもそのようなプロセスはありません。これらの環境ではプラットフォーム側のスケジューラが tick の役割を担い、アプリはタスクを登録するだけです。

- **Cloudflare Workers**: `guren cloudflare:build` が生成するワーカーは `scheduled` ハンドラを export しており、`wrangler.jsonc` の `triggers.crons` に書いたスケジュールでそのハンドラが呼ばれます。[Cloudflare Workers へのデプロイ](./cloudflare.md#スケジュールタスク)を参照してください。
- **AWS Lambda**: `@guren/core/lambda` の `createScheduleHandler(scheduler)` を EventBridge ルールにつなぎます。[サーバーレス](./serverless.md)を参照してください。

トリガーが発火するたびに、その時点で実行時刻を迎えているタスクだけが実行されます。そのため、プラットフォームのトリガーの頻度は、最も頻繁に動くタスクと同じか、それより細かくしてください。また、`preventOverlapping()` はタスクに付くメモリ上のフラグなので、プロセスが常駐しないランタイムでは、発火と発火の間では効きません。`runOnOneServer()` は取得の記録をスケジューラの `lock` に置くので、ロックの保存先が発火のあとも残っていれば効きます。既定のプロセス内ロックは残りません。`schedule.command()` は `node:child_process` でシェルを呼び出すため、Workers では動きません。Workers では `schedule.call()` か `schedule.job()` を使ってください。

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

キューのジョブを、スケジュールに沿ってディスパッチします。

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
  schedule.command('pg_dump "$DATABASE_URL" --file=backup.sql')
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

前回の実行がまだ終わっていなければ、今回の実行をスキップします。

```ts
schedule.call(longRunningTask)
  .everyMinute()
  .preventOverlapping()        // 前回の実行が終わっていなければスキップ

// 有効期限付き（10分後に自動アンロック）
schedule.call(task)
  .everyMinute()
  .preventOverlapping(600000)  // ミリ秒で10分
```

この重複防止は、そのプロセスの中でタスクに付けたフラグで判定しています。有効期限を付けないと、固まったままの実行が 1 つあるだけで、プロセスを再起動するまで以降の実行がすべて止まります。有効期限を付ければ、指定したミリ秒が経った時点で次の実行が始まり、固まっていた実行があとから終わっても、その実行には影響しません。

### 単一サーバーでの実行

複数のサーバーで動かす構成では、どのサーバーでもスケジューラが tick するので、スケジュールごとに 1 回だけ動かしたいタスクには、サーバー間で共有するロックが必要です。スケジューラに `SchedulerLock` を渡し、タスクに印を付けてください。

```ts
import { createScheduler, createRedisClient } from '@guren/core'
import { RedisSchedulerLock } from '@guren/core/redis'

const scheduler = createScheduler({
  lock: new RedisSchedulerLock(createRedisClient({ url: process.env.REDIS_URL })),
})

scheduler.schedule((schedule) => {
  schedule.call(task)
    .daily()
    .name('daily-report')
    .runOnOneServer()
})
```

取得の記録は、タスク名と実行時刻（分単位）をキーにして保存されます。そのため、タスクには `.name()` が必要です。記録は 1 時間保持され、実行が終わっても解放されません。解放してしまうと、時計が数秒遅れているサーバーが同じ分に達したときに、タスクがもう一度実行されてしまうからです。自分の重複防止のフラグでタスクがまだ止まっているサーバーは、取得自体を試みません。取得に成功したあとで `when()` / `skip()` によって実行を見送ったサーバーは記録を手放すので、その分の実行は別のサーバーが引き受けられます。

`MemorySchedulerLock` は単一プロセス用のロックで、サーバーが 1 台の構成やテストで使います。`lock` を渡さずに作ったスケジューラも、このロックを使います。2 台目のサーバーからは何も守れないので、暗黙のロックで動く `runOnOneServer()` タスクが最初に現れた時点で、`createScheduler({ lock })` と `RedisSchedulerLock` を案内する警告が表示されます。`.name()` がないタスクや名前が空文字のタスクは、記録のキーにする名前がないため、登録した時点と `start()` の時点で拒否されます。Redis 以外の保存先を使いたい場合は、`SchedulerLock` を自分で実装してください。`acquire(key, ttlSeconds)` では有効期限付きの set-if-absent をアトミックに行い、`release(key)` ではキーを削除します。

キーの先頭には、スケジューラの `lockPrefix`（既定は `'schedule:'`）が付きます。1 つのロックの保存先を 2 つのアプリで共有するときは、それぞれ別の prefix を設定してください。同じにしておくと、同名のタスクがあった場合に、本来 1 回ずつ動くはずの実行を 2 つのアプリで奪い合うことになります。

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

tick し続けるスケジューラーは、アプリケーションの中で動きます(前述の`scheduler.start()`)。
CLI が受け持つのはそれ以外の部分で、何が登録されているかの確認と、プロセスの外からの実行です。
プロセスの外からの実行は、システムの cron やプラットフォームのトリガーから呼び出します。

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

`schedule:list`と`schedule:run`はアプリケーションを boot しません。読み込むのはスケジュール
カーネルだけで、`app/Console/Kernel.ts`(小文字の版と`src/`の下の版も含む)か、
`--kernel`で渡したパスを探します。それ以外の場所で宣言したタスクは、
`scheduler.start()`では問題なく動いていても、この 2 つのコマンドからは見えません。

認識されるエクスポートの形は 2 通りあり、それぞれに命名規約があります。

**レジストラ**は、多くのアプリケーションですでに書かれている形です。アプリの実行時はプロバイダーが
スケジューラーを作って渡し、CLI から呼ぶときは CLI が自前のスケジューラーを渡します。

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
にするか、デフォルトエクスポートにします。1 つのカーネルから複数エクスポートしても
構いません。どれも同じスケジューラーを受け取ります。この命名規約があるので、CLI は
ファイルがたまたまエクスポートしているヘルパーまで呼んでしまうことがありません。規約に合わない
名前のレジストラは、黙って無視されず、「認識できない」と報告されます。

**カーネルファクトリ**は引数を取らず、組み立てた`Schedule`を返す関数です。
`scheduleTasksKernel`、`schedule`、`defineSchedule`という名前か、デフォルトエクスポート
であれば認識されます。`bunx guren add schedule`が生成するのはこの形です。

```ts
// app/Console/Kernel.ts
import { Schedule } from '@guren/core'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()
  schedule.call(warmCache).hourly().name('warm-cache')
  return schedule
}
```

ファクトリはタスクを宣言するだけで、それ自体は何も実行しません。宣言したタスクは、
プロバイダーがバインドするスケジューラーに別途渡してください。

```ts
for (const task of scheduleTasksKernel().buildTasks()) scheduler.addTask(task)
```

アプリケーションのコードでは、レジストラの形をおすすめします。このガイドのほかの箇所で
説明している`Scheduler` APIをそのまま使えて、つなぎのコードをもう一度書かなくても
タスクが実行中のスケジューラーに届くからです。

どちらの形でも、サービスはカーネルを組み立てるときではなく、タスクのコールバックの中で
解決してください。CLI はアプリを boot せずにこのファイルを読むので、組み立ての時点で
コンテナから取り出そうとしても、解決できるものがありません。

```ts
schedule.call(() => defaultContainer().make<SessionManager>('session').pruneExpired()).hourly()
```

カーネルがあるのにどちらの形にも当てはまらない場合や、読み込み中に例外を投げた
場合は、そのことを報告して 0 以外の終了コードで終わります。まだ何もスケジュールして
いないアプリとは、別の状態として扱われます。

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

1. **タスクに名前を付ける**: デバッグや管理がしやすくなるよう、常に`.name()`を付ける。

2. **頻度は必要な分だけにする**: 必要以上に頻繁にタスクを実行しない。

3. **タイムゾーンを明示する**: 実行時刻が重要なタスクでは、解釈の違いが出ないようタイムゾーンを設定する。

4. **長いタスクは重複を防ぐ**: 実行間隔より時間がかかりそうなタスクには`.preventOverlapping()`を付ける。

5. **失敗にきちんと対処する**: `.onFailure()`でエラーをログに残し、アラートを送る。

6. **スケジュールをテストする**: タスクのスケジュールが意図どおりかを確かめるテストを書く。

7. **タスクの実行を監視する**: 実行をログに残し、成功と失敗のメトリクスを追う。

8. **重い処理はジョブに回す**: 重い処理をスケジューラーで直接実行せず、ジョブをディスパッチする。
