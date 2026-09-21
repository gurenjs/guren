---
"@guren/server": patch
---

Use the SQS receive count for Lambda job attempts and stop executing handlers after maxAttempts. Keep terminal messages in partial batch failures for SQS redrive; failure callbacks must tolerate repeated delivery.

Process FIFO batches sequentially and return both failed and unprocessed records after the first failure. Standard queue batches retain concurrent processing.
