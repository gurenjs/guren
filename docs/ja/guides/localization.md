# ローカライゼーション

Gurenは多言語アプリケーションを構築するための包括的な国際化（i18n）システムを提供します。翻訳ファイル、変数置換、複数形、ロケール固有のフォーマットをサポートします。

## 設定

設定でi18nマネージャーを作成します：

```typescript
import { createI18n } from '@guren/core'

const i18n = createI18n({
  locale: 'ja',                    // デフォルトロケール
  fallbackLocale: 'en',            // 翻訳がない場合のフォールバック
  path: './lang',                  // 翻訳ファイルのパス
  messages: {                      // インラインメッセージ（オプション）
    en: {
      welcome: 'Welcome!',
      greeting: 'Hello, :name!',
    },
    ja: {
      welcome: 'ようこそ！',
      greeting: 'こんにちは、:nameさん！',
    },
  },
})

// 翻訳を使用
i18n.t('welcome')                    // "ようこそ！"
i18n.t('greeting', { name: '太郎' }) // "こんにちは、太郎さん！"
```

## 翻訳ファイル

### ファイル構造

JSONファイルで翻訳を整理します：

```
lang/
├── en/
│   ├── messages.json
│   ├── validation.json
│   └── auth.json
├── ja/
│   ├── messages.json
│   ├── validation.json
│   └── auth.json
└── es/
    ├── messages.json
    └── ...
```

### JSON形式

```json
// lang/ja/messages.json
{
  "welcome": "アプリへようこそ！",
  "greeting": "こんにちは、:nameさん！",
  "items": {
    "count": ":count件のアイテム"
  },
  "errors": {
    "notFound": "リクエストされたリソースが見つかりませんでした。",
    "unauthorized": "この操作を実行する権限がありません。"
  }
}
```

## 基本的な翻訳

### シンプルな翻訳

```typescript
// 直接翻訳
i18n.t('welcome')  // "アプリへようこそ！"

// ネストしたキー
i18n.t('errors.notFound')  // "リクエストされたリソースが見つかりませんでした。"
```

### 変数置換

Gurenは2つの置換構文をサポートします：

```typescript
// コロン構文（:name）
i18n.t('greeting', { name: '太郎' })  // "こんにちは、太郎さん！"

// ブレース構文（{name}）
// 翻訳: "こんにちは、{name}さん！"
i18n.t('greeting', { name: '花子' })  // "こんにちは、花子さん！"
```

### 複数の置換

```typescript
// 翻訳: "注文 :id - :customer様 (:date)"
i18n.t('order.summary', {
  id: '12345',
  customer: '山田商事',
  date: '2024年1月15日',
})
// "注文 12345 - 山田商事様 (2024年1月15日)"
```

## 複数形

### 基本的な複数形

パイプ文字`|`で単数形と複数形を区切ります：

```typescript
// 英語翻訳: "1 item|:count items"
i18n.setLocale('en')
i18n.tc('items.count', 1)   // "1 item"
i18n.tc('items.count', 5)   // "5 items"
i18n.tc('items.count', 0)   // "0 items"

// 日本語では複数形なし
// 翻訳: ":count件のアイテム"
i18n.setLocale('ja')
i18n.tc('items.count', 1)   // "1件のアイテム"
i18n.tc('items.count', 5)   // "5件のアイテム"
```

### 高度な複数形

複雑な複数形を持つ言語の場合：

```typescript
// ロシア語: 3つの形式（one, few, many）
// 翻訳: ":count яблоко|:count яблока|:count яблок"
i18n.setLocale('ru')
i18n.tc('apples', 1)   // "1 яблоко"
i18n.tc('apples', 3)   // "3 яблока"
i18n.tc('apples', 5)   // "5 яблок"
i18n.tc('apples', 21)  // "21 яблоко"
```

### サポート言語

Gurenは以下の複数形ルールを含みます：

| 言語 | 形式数 | ルール |
|------|--------|--------|
| 英語、ドイツ語、スペイン語、イタリア語、ポルトガル語、オランダ語 | 2 | 1 = 単数、それ以外 = 複数 |
| フランス語、ブラジルポルトガル語 | 2 | 0-1 = 単数、それ以外 = 複数 |
| 日本語、中国語、韓国語、ベトナム語、タイ語 | 1 | 複数形なし |
| ロシア語、ウクライナ語 | 3 | one, few (2-4), many (5+) |
| ポーランド語 | 3 | 1, few (2-4), many |
| チェコ語、スロバキア語 | 3 | 1, 2-4, 5+ |
| アラビア語 | 6 | 複雑なルール |

## ロケール管理

### ロケールの設定

```typescript
// 現在のロケールを取得
i18n.getLocale()  // "ja"

// ロケールを設定
i18n.setLocale('en')
i18n.t('welcome')  // "Welcome!"
```

### フォールバックロケール

翻訳がない場合、別のロケールにフォールバックします：

```typescript
const i18n = createI18n({
  locale: 'ja',
  fallbackLocale: 'en',
})

// 'newFeature'が日本語にない場合、英語を使用
i18n.t('newFeature')  // 英語翻訳にフォールバック
```

### スコープ付きトランスレーター

特定のロケール用のトランスレーターを作成します：

```typescript
const englishTranslator = i18n.forLocale('en')
englishTranslator.t('welcome')  // 常に英語

// 元のi18nは変更なし
i18n.t('welcome')  // デフォルトロケールを使用
```

## 翻訳の読み込み

### 遅延読み込み

必要に応じて翻訳を読み込みます：

```typescript
// 単一ロケールを読み込み
await i18n.loadLocale('es')

// 複数ロケールを読み込み
await i18n.loadLocales(['es', 'fr', 'de'])

// 読み込み済みか確認
i18n.isLocaleLoaded('es')  // true
```

### 名前空間の読み込み

特定の名前空間を読み込みます：

```typescript
// 日本語のバリデーションメッセージのみ読み込み
await i18n.loadNamespace('ja', 'validation')
```

### カスタムローダー

カスタム翻訳読み込みを実装します：

```typescript
import { TranslationLoader, TranslationMessages } from '@guren/core'

class DatabaseLoader implements TranslationLoader {
  async load(locale: string): Promise<TranslationMessages> {
    const translations = await db.query(
      'SELECT key, value FROM translations WHERE locale = ?',
      [locale]
    )
    return Object.fromEntries(translations.map(t => [t.key, t.value]))
  }

  async getAvailableLocales(): Promise<string[]> {
    const result = await db.query('SELECT DISTINCT locale FROM translations')
    return result.map(r => r.locale)
  }
}

i18n.setLoader(new DatabaseLoader())
```

## グローバルヘルパー

### グローバルインスタンスの設定

```typescript
import { createI18n, setI18n, t, tc } from '@guren/core'

const i18n = createI18n({ /* config */ })
setI18n(i18n)

// i18nインスタンスをインポートせずにどこでも使用可能
t('welcome')
tc('items.count', 5)
```

### コントローラーで使用

```typescript
import { Controller, t, tc } from '@guren/core'

export default class ProductController extends Controller {
  async index() {
    const products = await Product.all()

    return this.json({
      message: t('products.loaded'),
      count: tc('products.count', products.length),
      data: products,
    })
  }
}
```

## CLIコマンド

### 言語ファイルの公開

デフォルトの言語ファイルテンプレートを生成します：

```bash
# デフォルトの言語ファイル構造を作成
bunx guren lang:publish

# 特定のディレクトリに公開
bunx guren lang:publish --path resources/lang
```

これにより作成されます：
```
lang/
├── en/
│   ├── messages.json
│   ├── validation.json
│   └── auth.json
```

### 新しいロケールの作成

新しい言語を追加します：

```bash
# 日本語ロケールファイルを作成
bunx guren make:lang ja

# 既存のロケールから作成（構造をコピー）
bunx guren make:lang ja --from en
```

## ミドルウェア統合

### ロケール検出ミドルウェア

```typescript
import { defineMiddleware } from '@guren/core'

export const localeMiddleware = defineMiddleware(async (ctx, next) => {
  // クエリパラメータをチェック
  let locale = ctx.request.query('locale')

  // Cookieをチェック
  if (!locale) {
    locale = ctx.request.cookie('locale')
  }

  // Accept-Languageヘッダーをチェック
  if (!locale) {
    const acceptLanguage = ctx.request.header('Accept-Language')
    locale = parseAcceptLanguage(acceptLanguage)
  }

  // 有効な場合はロケールを設定
  if (locale && i18n.getAvailableLocales().includes(locale)) {
    i18n.setLocale(locale)
  }

  await next()
})
```

## コントローラー統合

```typescript
import { Controller } from '@guren/core'
import { appPages } from '@/resources/js/pages/contracts'

export default class HomeController extends Controller {
  async index() {
    // ユーザーの優先ロケールを取得
    const locale = this.request.query('locale') || 'ja'

    // ロケール固有のトランスレーターを作成
    const t = this.app.i18n.forLocale(locale)

    return this.inertia(appPages.home, {
      title: t.t('pages.home.title'),
      description: t.t('pages.home.description'),
    })
  }
}
```

## ベストプラクティス

1. **名前空間を使用** - 機能/モジュール別に翻訳を整理
2. **キーを一貫させる** - ネストしたキーにはドット記法を使用
3. **コンテキストを含める** - `submit`だけでなく`button.submit`のような説明的なキー名を使用
4. **欠落した翻訳を処理** - 常にフォールバックロケールを設定
5. **ロケールを遅延読み込み** - 必要な時だけ翻訳を読み込む
6. **複数形を使用** - 単数/複数形をハードコードしない
7. **早めに文字列を抽出** - コードにハードコードされた文字列を残さない

## 翻訳ファイル例

### バリデーションメッセージ

```json
// lang/ja/validation.json
{
  "required": ":attributeは必須です。",
  "email": ":attributeは有効なメールアドレスである必要があります。",
  "min": {
    "string": ":attributeは:min文字以上である必要があります。",
    "numeric": ":attributeは:min以上である必要があります。"
  },
  "max": {
    "string": ":attributeは:max文字以下である必要があります。",
    "numeric": ":attributeは:max以下である必要があります。"
  }
}
```

### 認証メッセージ

```json
// lang/ja/auth.json
{
  "failed": "認証情報が記録と一致しません。",
  "password": "入力されたパスワードが正しくありません。",
  "throttle": "ログイン試行回数が多すぎます。:seconds秒後に再試行してください。",
  "logout": {
    "success": "正常にログアウトしました。"
  }
}
```
