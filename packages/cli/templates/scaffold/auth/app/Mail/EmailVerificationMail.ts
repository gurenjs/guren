import { mail, type MailManager } from '@guren/core'

export async function sendEmailVerificationMail(manager: MailManager, email: string, verifyUrl: string): Promise<void> {
  await mail(manager)
    .to(email)
    .subject('Verify your email address')
    .html(`
      <h1>Verify your email address</h1>
      <p>Click the link below to verify your email address.</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
      <p>If you didn't create an account, you can safely ignore this email.</p>
    `)
    .text(`
Verify your email address

Click the link below to verify your email address.

${verifyUrl}

If you didn't create an account, you can safely ignore this email.
    `)
    .send()
}
