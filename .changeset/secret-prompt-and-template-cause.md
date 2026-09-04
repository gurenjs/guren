---
'@guren/server': patch
---

Keep the cause of a failed `Mail.template()` render, and stop `Command.secret()`
from leaking its input listener between prompts.

`template()` caught every failure and threw a fixed "Make sure
@react-email/render is installed" message, discarding the error that actually
occurred. A template that threw while rendering, or a `render()` that failed for
its own reasons, reported a missing package. The two failures are now
distinguished: a failed module load keeps the install hint, a failed render does
not, both name the component, and both attach the original error as `cause`.

`secret()` registered a `data` listener to mask typed characters and never
removed it. A command prompting twice left the first prompt's listener attached,
so the second prompt echoed the first prompt's label and its own character
count, and raw mode was never restored. The listener is now removed and raw mode
reset on every exit path.

All four prompts — `ask()`, `confirm()`, `choice()` and `secret()` — now share
one lifecycle and handle input ending before an answer arrives. Every one of
them previously left the promise unsettled forever in that case, which is the
unattended-command scenario the console guide tells you to guard against. Input
ending with an unterminated line resolves with what was typed. Input ending with
nothing typed resolves to the caller's default for `ask()`, `confirm()` and
`choice()`, and rejects for `secret()`, where no default is safe.

The mask writes to the same stream `createReadline()` echoes to, reached through
the new overridable `inputStream()` / `outputStream()` accessors. `outputStream()`
derives from whatever output `setOutput()` installed, via a new optional
`stream()` on `OutputInterface` that `Output` implements, so redirecting a
command's output now redirects its prompts with it rather than leaving them
pinned to the real `process.stdout`.
