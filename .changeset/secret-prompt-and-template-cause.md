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
reset on every exit path, including the one where input ends before an answer
arrives. That path previously never settled the promise at all; input ending
with an unterminated line now resolves with what was typed, and input ending
with nothing typed rejects instead of hanging.

The mask writes to the same stream `createReadline()` echoes to, reached through
the new overridable `inputStream()` / `outputStream()` accessors.
