# Security Policy

## Supported Versions

Guren follows semantic versioning for stable releases.

| Version line | Status |
| --- | --- |
| `0.x` (alpha/beta) | Best effort, latest only |
| `1.x` (stable) | Supported |
| `2.x` (stable) | Supported |

For pre-1.0 releases, security fixes are made on the latest published release line only.

## Reporting a Vulnerability

Please do **not** open public issues for vulnerabilities.

Report security issues by emailing the maintainers listed in `CODE_OF_CONDUCT.md` with:

- affected package(s) and version(s)
- reproduction steps or proof-of-concept
- impact assessment (confidentiality, integrity, availability)
- suggested remediation if available

We target the following response windows:

- acknowledgment: within 72 hours
- initial triage: within 7 days
- coordinated fix and disclosure timeline: shared after triage

## Disclosure Process

1. We confirm and triage the report privately.
2. We prepare a fix and regression tests.
3. We publish patched release(s) and changelog/security notes.
4. We coordinate public disclosure after a fix is available.

## Security Hardening Guidance

- Keep Bun and dependencies updated.
- Use secret managers for production credentials.
- Enable HTTPS and restrict admin/debug endpoints.
- Run periodic backup and restore drills.
