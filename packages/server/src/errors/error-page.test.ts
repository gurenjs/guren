import { describe, test, expect } from 'bun:test'
import { renderErrorPage } from './error-page'

describe('renderErrorPage', () => {
  test('should return valid HTML with DOCTYPE', () => {
    const html = renderErrorPage(404)
    expect(html).toStartWith('<!DOCTYPE html>')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('</html>')
  })

  test('should include the status code in the page', () => {
    const html = renderErrorPage(500)
    expect(html).toContain('>500<')
    expect(html).toContain('<title>500 Server Error</title>')
  })

  test('should use known title for common status codes', () => {
    expect(renderErrorPage(404)).toContain('Not Found')
    expect(renderErrorPage(403)).toContain('Forbidden')
    expect(renderErrorPage(401)).toContain('Unauthorized')
    expect(renderErrorPage(500)).toContain('Server Error')
    expect(renderErrorPage(503)).toContain('Service Unavailable')
  })

  test('should use default description for known status codes', () => {
    const html = renderErrorPage(404)
    expect(html).toContain('The page you are looking for could not be found.')
  })

  test('should use custom message when provided', () => {
    const html = renderErrorPage(404, 'The post was deleted.')
    expect(html).toContain('The post was deleted.')
    // Should not contain the default description
    expect(html).not.toContain('The page you are looking for could not be found.')
  })

  test('should fall back to generic title for unknown status codes', () => {
    const html = renderErrorPage(418)
    expect(html).toContain('<title>418 Error</title>')
  })

  test('should fall back to generic description for unknown status codes', () => {
    const html = renderErrorPage(418)
    expect(html).toContain('An unexpected error occurred.')
  })

  test('should include a link back to the home page', () => {
    const html = renderErrorPage(500)
    expect(html).toContain('href="/"')
    expect(html).toContain('Go Home')
  })

  test('should not expose stack traces or internal details', () => {
    const html = renderErrorPage(500)
    expect(html).not.toContain('stack')
    expect(html).not.toContain('exception')
    expect(html).not.toContain('Error:')
  })

  test('should include inline styles (no external dependencies)', () => {
    const html = renderErrorPage(404)
    expect(html).toContain('<style>')
    expect(html).not.toContain('<link rel="stylesheet"')
    expect(html).not.toContain('<script')
  })

  test('should include viewport meta tag for responsive layout', () => {
    const html = renderErrorPage(404)
    expect(html).toContain('<meta name="viewport"')
  })
})
