import { Module } from '@nestjs/common';
import { apiConfig } from '../../app.wiring';
import {
  AUTH_MAIL_CONFIG,
  AUTH_MAIL_TRANSPORT,
  AuthMailer,
  createSmtpTransport,
} from './auth-mailer';

@Module({
  providers: [
    AuthMailer,
    { provide: AUTH_MAIL_CONFIG, useValue: apiConfig },
    { provide: AUTH_MAIL_TRANSPORT, useFactory: createSmtpTransport, inject: [AUTH_MAIL_CONFIG] },
  ],
  exports: [AuthMailer],
})
export class AuthMailModule {}
