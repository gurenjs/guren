---
"@guren/server": patch
---

Use the SQS receive count for Lambda job attempts and stop executing handlers after maxAttempts. `failed()` runs once, on the delivery that spends the last attempt and with that attempt's error, matching the queue worker; later deliveries run neither callback and keep the message in the partial batch response for SQS redrive. Every record the handler runs logs its job name, attempt and error as JSON when it fails, and a FIFO batch that stops logs the records it left unprocessed, so a record that reaches the dead-letter queue without running is no longer silent.

Process FIFO batches sequentially and return both failed and unprocessed records after the first failure. Standard queue batches retain concurrent processing.
