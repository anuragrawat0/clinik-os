import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { logger, PinoNestLogger } from './core/logging/logger';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: new PinoNestLogger(),
  });
  app.enableShutdownHooks();
}

bootstrap().catch((error: unknown) => {
  logger.fatal(
    { errorName: error instanceof Error ? error.name : 'UnknownError' },
    'Worker startup failed',
  );
  process.exitCode = 1;
});
