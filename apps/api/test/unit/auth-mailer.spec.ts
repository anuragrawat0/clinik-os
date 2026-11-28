import { expect, it, vi } from 'vitest';
import { logger } from '../../src/core/logging/logger';
import { AuthMailer } from '../../src/modules/notifications/auth-mailer';

it('logs SMTP connection errors without logging the email address', async () => {
  const email = 'synthetic-recipient@clinik.test';
  const transport = {
    sendMail: vi.fn().mockRejectedValue(
      Object.assign(new Error(`Unable to deliver to ${email}`), {
        code: 'ECONNREFUSED',
        responseCode: 421,
      }),
    ),
  };
  const mailer = new AuthMailer(transport, {
    SMTP_HOST: 'localhost',
    SMTP_PORT: 1025,
    APP_BASE_URL: 'http://127.0.0.1:3000',
    MAIL_FROM: 'no-reply@clinik.test',
  });
  const log = vi.spyOn(logger, 'warn');
  try {
    await expect(mailer.sendInvitation(email, undefined, 'example-token')).resolves.toBe('failed');
    await mailer.send('password_reset', 'example-token', async () => email);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      { errorClass: 'Error', systemCode: 'ECONNREFUSED', responseCode: 421 },
      'An authentication email could not be sent.',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(email);
  } finally {
    log.mockRestore();
  }
});
