/** The sample classes the service blueprints write, by the name their generator takes; `plan/command-targets.ts` judges a plan's `add <blueprint>` by them. */
export const BLUEPRINT_SAMPLES = {
  event: 'OrderPlaced',
  listener: 'SendOrderReceipt',
  mail: 'WelcomeEmail',
  job: 'ProcessWelcomeSequence',
  notification: 'WelcomeUser',
} as const

export const ADMIN_DASHBOARD_CONTROLLER_PATH = 'app/Http/Controllers/Admin/AdminDashboardController.ts'

export const OAUTH_CONTROLLER_PATH = 'app/Http/Controllers/Auth/OAuthController.ts'
