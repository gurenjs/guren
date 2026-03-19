# Localization

Guren provides a comprehensive internationalization (i18n) system for building multilingual applications. It supports translation files, variable replacement, pluralization, and locale-specific formatting.

## Configuration

Create an i18n manager with your configuration:

```typescript
import { createI18n } from '@guren/server'

const i18n = createI18n({
  locale: 'en',                    // Default locale
  fallbackLocale: 'en',            // Fallback when translation missing
  path: './lang',                  // Path to translation files
  messages: {                      // Inline messages (optional)
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

// Use translations
i18n.t('welcome')                    // "Welcome!"
i18n.t('greeting', { name: 'John' }) // "Hello, John!"
```

## Translation Files

### File Structure

Organize translations in JSON files:

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

### JSON Format

```json
// lang/en/messages.json
{
  "welcome": "Welcome to our app!",
  "greeting": "Hello, :name!",
  "items": {
    "count": "You have :count item|You have :count items"
  },
  "errors": {
    "notFound": "The requested resource was not found.",
    "unauthorized": "You are not authorized to perform this action."
  }
}
```

## Basic Translation

### Simple Translation

```typescript
// Direct translation
i18n.t('welcome')  // "Welcome to our app!"

// Nested keys
i18n.t('errors.notFound')  // "The requested resource was not found."
```

### Variable Replacement

Guren supports two replacement syntaxes:

```typescript
// Colon syntax (:name)
i18n.t('greeting', { name: 'John' })  // "Hello, John!"

// Brace syntax ({name})
// In translation: "Hello, {name}!"
i18n.t('greeting', { name: 'Jane' })  // "Hello, Jane!"
```

### Multiple Replacements

```typescript
// Translation: "Order :id by :customer on :date"
i18n.t('order.summary', {
  id: '12345',
  customer: 'Acme Corp',
  date: '2024-01-15',
})
// "Order 12345 by Acme Corp on 2024-01-15"
```

## Pluralization

### Basic Pluralization

Use the pipe character `|` to separate singular and plural forms:

```typescript
// Translation: "1 item|:count items"
i18n.tc('items.count', 1)   // "1 item"
i18n.tc('items.count', 5)   // "5 items"
i18n.tc('items.count', 0)   // "0 items"

// With replacements
// Translation: ":name has :count apple|:name has :count apples"
i18n.tc('apples', 3, { name: 'John' })  // "John has 3 apples"
```

### Advanced Pluralization

For languages with complex plural forms:

```typescript
// Russian: three forms (one, few, many)
// Translation: ":count яблоко|:count яблока|:count яблок"
i18n.setLocale('ru')
i18n.tc('apples', 1)   // "1 яблоко"
i18n.tc('apples', 3)   // "3 яблока"
i18n.tc('apples', 5)   // "5 яблок"
i18n.tc('apples', 21)  // "21 яблоко"
```

### Supported Languages

Guren includes pluralization rules for:

| Language | Forms | Rule |
|----------|-------|------|
| English, German, Spanish, Italian, Portuguese, Dutch | 2 | 1 = singular, else plural |
| French, Brazilian Portuguese | 2 | 0-1 = singular, else plural |
| Japanese, Chinese, Korean, Vietnamese, Thai | 1 | No plurals |
| Russian, Ukrainian | 3 | one, few (2-4), many (5+) |
| Polish | 3 | 1, few (2-4), many |
| Czech, Slovak | 3 | 1, 2-4, 5+ |
| Arabic | 6 | Complex rules |

## Locale Management

### Setting Locale

```typescript
// Get current locale
i18n.getLocale()  // "en"

// Set locale
i18n.setLocale('ja')
i18n.t('welcome')  // "ようこそ！"
```

### Fallback Locale

When a translation is missing, fallback to another locale:

```typescript
const i18n = createI18n({
  locale: 'ja',
  fallbackLocale: 'en',
})

// If 'newFeature' doesn't exist in Japanese, use English
i18n.t('newFeature')  // Falls back to English translation
```

### Scoped Translator

Create a translator for a specific locale:

```typescript
const japaneseTranslator = i18n.forLocale('ja')
japaneseTranslator.t('welcome')  // Always in Japanese

// Original i18n unchanged
i18n.t('welcome')  // Still uses default locale
```

## Loading Translations

### Lazy Loading

Load translations on demand:

```typescript
// Load single locale
await i18n.loadLocale('es')

// Load multiple locales
await i18n.loadLocales(['es', 'fr', 'de'])

// Check if loaded
i18n.isLocaleLoaded('es')  // true
```

### Namespace Loading

Load specific namespaces:

```typescript
// Load only validation messages for Japanese
await i18n.loadNamespace('ja', 'validation')
```

### Custom Loader

Implement custom translation loading:

```typescript
import { TranslationLoader, TranslationMessages } from '@guren/server'

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

## Global Helpers

### Setting Global Instance

```typescript
import { createI18n, setI18n, t, tc } from '@guren/server'

const i18n = createI18n({ /* config */ })
setI18n(i18n)

// Use anywhere without importing i18n instance
t('welcome')
tc('items.count', 5)
```

### In Controllers

```typescript
import { Controller, t, tc } from '@guren/server'

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

## CLI Commands

### Publish Language Files

Generate default language file templates:

```bash
# Create default language files structure
bunx guren lang:publish

# Publish to specific directory
bunx guren lang:publish --path resources/lang
```

This creates:
```
lang/
├── en/
│   ├── messages.json
│   ├── validation.json
│   └── auth.json
```

### Create New Locale

Add a new language:

```bash
# Create Japanese locale files
bunx guren make:lang ja

# Create from existing locale (copy structure)
bunx guren make:lang ja --from en
```

## Middleware Integration

### Locale Detection Middleware

```typescript
import { defineMiddleware } from '@guren/server'

export const localeMiddleware = defineMiddleware(async (ctx, next) => {
  // Check query parameter
  let locale = ctx.request.query('locale')

  // Check cookie
  if (!locale) {
    locale = ctx.request.cookie('locale')
  }

  // Check Accept-Language header
  if (!locale) {
    const acceptLanguage = ctx.request.header('Accept-Language')
    locale = parseAcceptLanguage(acceptLanguage)
  }

  // Set locale if valid
  if (locale && i18n.getAvailableLocales().includes(locale)) {
    i18n.setLocale(locale)
  }

  await next()
})
```

## Controller Integration

```typescript
import { Controller } from '@guren/server'

export default class HomeController extends Controller {
  async index() {
    // Get user's preferred locale
    const locale = this.request.query('locale') || 'en'

    // Create locale-specific translator
    const t = this.app.i18n.forLocale(locale)

    return this.inertia('Home', {
      title: t.t('pages.home.title'),
      description: t.t('pages.home.description'),
    })
  }
}
```

## Best Practices

1. **Use namespaces** - Organize translations by feature/module
2. **Keep keys consistent** - Use dot notation for nested keys
3. **Include context** - Use descriptive key names like `button.submit` not just `submit`
4. **Handle missing translations** - Always set a fallback locale
5. **Lazy load locales** - Only load translations when needed
6. **Use pluralization** - Don't hardcode singular/plural forms
7. **Extract strings early** - Don't leave hardcoded strings in code

## Translation File Examples

### Validation Messages

```json
// lang/en/validation.json
{
  "required": "The :attribute field is required.",
  "email": "The :attribute must be a valid email address.",
  "min": {
    "string": "The :attribute must be at least :min characters.",
    "numeric": "The :attribute must be at least :min."
  },
  "max": {
    "string": "The :attribute may not be greater than :max characters.",
    "numeric": "The :attribute may not be greater than :max."
  }
}
```

### Authentication Messages

```json
// lang/en/auth.json
{
  "failed": "These credentials do not match our records.",
  "password": "The provided password is incorrect.",
  "throttle": "Too many login attempts. Please try again in :seconds seconds.",
  "logout": {
    "success": "You have been logged out successfully."
  }
}
```
