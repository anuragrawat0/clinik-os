import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadApiConfig } from './core/config/config';
import { logger, PinoNestLogger } from './core/logging/logger';
import { AppModule } from './app.module';
import { configureHttpApp } from './http-app';

async function bootstrap(): Promise<void> {
  const config = loadApiConfig();
  const app = await NestFactory.create(AppModule, {
    logger: new PinoNestLogger(),
  });
  configureHttpApp(app);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');
  logger.info({ port: config.API_PORT }, 'Clinik OS API listening');
}

bootstrap().catch((error: unknown) => {
  logger.fatal(
    { errorName: error instanceof Error ? error.name : 'UnknownError' },
    'API startup failed',
  );
  process.exitCode = 1;
});
