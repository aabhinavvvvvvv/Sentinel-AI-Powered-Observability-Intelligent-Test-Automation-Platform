/**
 * Sends emails over SMTP (the standard protocol email servers use).
 * Locally SMTP_URL points at Mailpit, so emails land in a fake inbox.
 */
import nodemailer from "nodemailer";

export interface Email {
  to: string[];
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
  close(): void;
}

export function createMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to: to.join(", "), subject, text });
    },
    close() {
      transport.close();
    },
  };
}
