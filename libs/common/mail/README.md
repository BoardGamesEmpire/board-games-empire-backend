# @bge/mail

What outgoing mail needs, short of sending it (#654):

- `MAIL_SETTINGS_SELECT` and `MailSettings`: the mail settings columns of the `SystemSetting` row, and `isMailConfigured`.
- `smtpTransportOptions` and `mailFrom`: nodemailer's options and the sender, built from those columns and the decrypted SMTP password.
- `MailFailureCode`, `classifyMailError` and `mailTestResultMessageKey`: stable failure codes and the catalog key of the test email's outcome.
- `renderMail` and `formatLinkLifetime`: plain-text messages from the `mail` catalog, in the recipient's language.

This lib never sends. Sending is the mail queue's worker (`@bge/queue-mail`), and the api imports no nodemailer.

## No secrets in logs

The SMTP password reaches this lib only as plain text in an argument. Nothing here stores, returns or logs it, and callers must not log the settings row's `smtpPassword` (the ciphertext) either. A reset link carries a single-use token, so no log line prints a link or a message's text.
