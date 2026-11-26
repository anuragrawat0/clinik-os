import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadApiConfig } from './core/config/config';
import { logger, PinoNestLogger } from './core/logging/logger';
import { logApiStartupFailure, type StartupStep } from './core/logging/startup-failure';
import { configureHttpApp } from './http-app';

async function bootstrap(): Promise<void> {
  let step: StartupStep = 'config.load';
  let app: INestApplication | undefined;
  try {
    const config = loadApiConfig();
    step = 'nest.create';
    const { AppModule } = await import('./app.module.js');
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      logger: new PinoNestLogger(),
    });
    step = 'http.configure';
    configureHttpApp(app);
    step = 'http.init';
    await app.init();
    step = 'http.listen';
    await app.listen(config.API_PORT, '0.0.0.0');
    app.enableShutdownHooks();
    logger.info({ port: config.API_PORT }, 'Clinik OS API listening');
  } catch (error: unknown) {
    logApiStartupFailure(logger, step, error);
    process.exitCode = 1;
    await app?.close().catch(() => undefined);
  }
}

void bootstrap();
