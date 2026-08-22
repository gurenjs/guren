# @guren/plugin-markdown

## 0.2.1

### Patch Changes

- 8871c4c: Build with tsdown instead of tsup, and emit declarations with the native TypeScript 7 compiler. The public file layout of every package is unchanged (same `dist/*.js` / `dist/*.d.ts` entry names, shebangs, and `exports`); only the internal chunk names differ. tsup is unmaintained and its declaration bundler needs the JavaScript compiler API that TypeScript 7 no longer ships.
- Updated dependencies [deaa5c0]
- Updated dependencies [8871c4c]
  - @guren/core@1.8.1

## 0.2.0

### Minor Changes

- a70e741: Add an `alertLabels` renderer option overriding the label text per alert type (i18n, or a different vocabulary — several types may share one label). Class names are unaffected, and omitted types keep their default label.
