import { defineArchRules } from '@guren/cli/arch'

// Read by `guren check` (and so `guren gate`). The rules see each file's own runtime
// imports, not what a local module it imports reaches.
export default defineArchRules({
  rules: [
    {
      from: 'resources/js/**',
      disallowPackages: ['drizzle-orm', 'postgres', 'mysql2', '@guren/orm', '@guren/core'],
      message: 'Pages run in the browser; load data in the controller and pass it as props.',
    },
    {
      from: 'app/Http/Controllers/**',
      disallowPackages: ['drizzle-orm'],
      severity: 'warn',
      message: 'Query through a Model, or move the raw query out of the controller.',
    },
  ],
})
