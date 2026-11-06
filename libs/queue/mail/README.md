# @bge/queue-mail

The queue for outgoing mail, and the worker's sender (#654).

- **Producer** (`MailQueueProducerModule`, `MailDispatcherService.enqueue(recipientUserId, message)`): the api adds a job and never connects to an SMTP server. While the queue's Redis connection is down it throws `MailQueueUnavailableError` at once, since the queue's client would otherwise hold the add until Redis is back. Otherwise it throws whatever `queue.add` throws, so the caller decides what a lost mail means.
- **Consumer** (`MailQueueConsumerModule`): the worker reads the mail settings from the `SystemSetting` row for every job, decrypts the SMTP password, renders the message in the recipient's language and sends it over a new, unpooled nodemailer transport.

## Retries and failures

A password reset is added with five attempts and exponential backoff from five seconds. A test email gets one attempt, so the admin hears back at once.

- A reset that fails for a reason a retry can mend is rethrown, and BullMQ retries it. That includes the SMTP server's temporary (4xx) refusals, such as greylisting.
- A reset with nothing set up, with a stored password that no longer decrypts, or refused for good by the SMTP server (a 5xx answer, such as bad credentials) throws `UnrecoverableError` with the code (`MAIL_NOT_CONFIGURED`, `MAIL_SETTINGS_UNREADABLE`, `MAIL_AUTH_FAILED` and so on) as its message. Retrying bad credentials would only log in wrong again, which can lock the account at the provider.
- A test email never throws for these. It writes a `MailTestResult` notification for the admin, with the outcome, the stable code and a plain-language message, and completes.

## No secrets in logs

Every job is removed when it completes or fails for good, because a reset's data holds a single-use link. No log line carries a job's data, a link, the SMTP password or its ciphertext: the processor logs the job id and the classified code.
