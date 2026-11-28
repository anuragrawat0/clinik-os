import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type SendMailOptions } from 'nodemailer';
import type { ApiConfig } from '../../core/config/config';
import { logger } from '../../core/logging/logger';
import { errorClass, errorCode } from '../../core/logging/startup-failure';

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

function logDeliveryFailure(error: unknown): void {
  const responseCode =
    error instanceof Error && 'responseCode' in error ? error.responseCode : undefined;
  logger.warn(
    {
      errorClass: errorClass(error),
      systemCode: errorCode(error),
      responseCode:
        typeof responseCode === 'number' &&
        Number.isInteger(responseCode) &&
        responseCode >= 100 &&
        responseCode <= 599
          ? responseCode
          : undefined,
    },
    'An authentication email could not be sent.',
  );
}

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
      await this.deliver(to, '', template.subject, template.message, url);
    } catch (error) {
      logDeliveryFailure(error);
    }
  }

  async sendInvitation(
    email: string,
    fullName: string | undefined,
    token: string,
  ): Promise<'sent' | 'failed'> {
    try {
      await this.deliver(
        email,
        fullName ?? '',
        'Your Clinik OS invitation',
        'Open this link to accept your invitation. It expires in 7 days.',
        new URL(`/invite/${token}`, this.config.APP_BASE_URL),
      );
      return 'sent';
    } catch (error) {
      logDeliveryFailure(error);
      return 'failed';
    }
  }

  private async deliver(
    to: string,
    name: string,
    subject: string,
    message: string,
    url: URL,
  ): Promise<void> {
    await this.transport.sendMail({
      from: this.config.MAIL_FROM,
      to: { name, address: to },
      subject,
      text: `${message}\n\n${url.toString()}\n\nIf you did not request this, you can ignore this email.\n`,
    });
  }
}
