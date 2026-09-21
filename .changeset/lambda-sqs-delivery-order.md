---
"@guren/server": patch
---

Use the SQS receive count for Lambda job attempts and stop executing handlers after maxAttempts. `failed()` runs once, on the delivery that spends the last attempt and with that attempt's error, matching the queue worker; later deliveries run neither callback and keep the message in the partial batch response for SQS redrive. Every reported record logs its job name, attempt and error as JSON, so a record rejected before it reaches a job is no longer silent.

Process FIFO batches sequentially and return both failed and unprocessed records after the first failure. Standard queue batches retain concurrent processing.
