---
'@guren/cli': minor
---

`make:ai-agent <Name> --chat` writes a chat page that streams the agent. Beside the agent it writes `<Name>ChatController` (`show()` renders the page with the stored history, `chat()` validates `ChatTurnSchema` and returns `stream()`), `routes/<name>-chat.ts` with `GET` and `POST /<name>/chat` (`<name>.chat`, `<name>.send`) behind sign-in, mounted in `routes/web.ts`, and `resources/js/pages/<name>/Chat.tsx`. The page renders `resources/js/components/ai/AgentChat.tsx`, which is copied into the app once and then left alone unless `--force`: streaming with a Stop button, a masked error, each tool call with its state, input and output, and the history restored after a reload, styled with Guren UI tokens and the `Alert`, `Button` and `Textarea` components (copied when missing). The command notes a missing `@ai-sdk/react` 4.x and a `config/ai.ts` with no `conversations`, and refuses `--output`, `--module` and an API-only app before writing anything.
