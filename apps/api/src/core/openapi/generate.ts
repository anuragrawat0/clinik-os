import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { logger, PinoNestLogger } from '../logging/logger';

async function generateOpenApi(): Promise<void> {
  process.env.NODE_ENV ??= 'test';
  process.env.DATABASE_URL ??= 'postgresql://clinic_app:local@127.0.0.1:5432/clinik_os';
  const { AppModule } = await import('../../app.module.js');
  const { configureHttpApp } = await import('../../http-app.js');
  const app = await NestFactory.create(AppModule, { logger: new PinoNestLogger() });
  const document = configureHttpApp(app);
  const destination = resolve(process.cwd(), 'openapi', 'openapi.json');
  await mkdir(resolve(process.cwd(), 'openapi'), { recursive: true });
  await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await app.close();
  logger.info({ destination }, 'OpenAPI snapshot generated');
}

generateOpenApi().catch((error: unknown) => {
  logger.fatal(
    { errorName: error instanceof Error ? error.name : 'UnknownError' },
    'OpenAPI generation failed',
  );
  process.exitCode = 1;
});
