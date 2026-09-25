/**
 * Subprocess fixture for `application-dev-banner.test.ts`: a fresh process, so no
 * earlier test has loaded the banner module and the direct call starts cold.
 */
import { Application } from '../../src/http/Application'

new Application().logDevServerBanner({ hostname: '127.0.0.1', port: 4321, assetsUrl: 'http://localhost:5173' })
console.log('CALLED')
