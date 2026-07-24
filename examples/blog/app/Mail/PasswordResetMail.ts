import { mail, type MailManager } from '@guren/core'

export async function sendPasswordResetMail(manager: MailManager, email: string, resetUrl: string): Promise<void> {
  await mail(manager)
    .to(email)
    .subject('Reset your password')
    .html(`
      <h1>Reset your password</h1>
      <p>Click the link below to choose a new password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `)
    .text(`
Reset your password

Click the link below to choose a new password. This link expires in 1 hour.

${resetUrl}

If you didn't request this, you can safely ignore this email.
    `)
    .send()
}
