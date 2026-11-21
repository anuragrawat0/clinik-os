import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type SendMailOptions } from 'nodemailer';
import type { ApiConfig } from '../../core/config/config';
import { logger } from '../../core/logging/logger';

export const AUTH_MAIL_TRANSPORT = Symbol('AUTH_MAIL_TRANSPORT');
export const AUTH_MAIL_CONFIG = Symbol('AUTH_MAIL_CONFIG');

export type AuthMailConfig = Pick<
  ApiConfig,
  'SMTP_HOST' | 'SMTP_PORT' | 'MAIL_FROM' | 'APP_BASE_URL'
>;

export interface AuthMailTransport {
  sendMail(message: SendMailOptions): Promise<unknown>;
}

export function createSmtpTransport(config: AuthMailConfig): AuthMailTransport {
  return createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

const templates = {
  password_reset: {
    path: '/reset-password',
    subject: 'Reset your Clinik OS password',
    message: 'Open this link to reset your password. It expires in 30 minutes.',
  },
  email_verify: {
    path: '/verify-email',
    subject: 'Verify your Clinik OS email',
    message: 'Open this link to verify your email. It expires in 24 hours.',
  },
} as const;

@Injectable()
export class AuthMailer {
  constructor(
    @Inject(AUTH_MAIL_TRANSPORT) private readonly transport: AuthMailTransport,
    @Inject(AUTH_MAIL_CONFIG) private readonly config: AuthMailConfig,
  ) {}

  async send(
    purpose: keyof typeof templates,
    rawToken: string,
    findRecipient: () => Promise<string | undefined>,
  ): Promise<void> {
    try {
      const to = await findRecipient();
      if (!to) return;
      const template = templates[purpose];
      const url = new URL(template.path, this.config.APP_BASE_URL);
      url.searchParams.set('token', rawToken);
      await this.transport.sendMail({
        from: this.config.MAIL_FROM,
        to: { name: '', address: to },
        subject: template.subject,
        text: `${template.message}\n\n${url.toString()}\n\nIf you did not request this, you can ignore this email.\n`,
      });
    } catch {
      logger.warn('An authentication email could not be sent.');
    }
  }
}
