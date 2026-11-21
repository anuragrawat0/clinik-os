/**
 * Test-only entrypoint run under `tsx` (the same loader as `pnpm start:dev`, which has no
 * emitDecoratorMetadata). It boots the real AppModule plus a guarded probe controller and prints
 * the port. The probe lives here, never in src.
 */
import 'reflect-metadata';
import { Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';

@Controller('__probe')
class ProbeController {
  @Get('secure') read(): { ok: true } {
    return { ok: true };
  }
  @Post('secure') write(): { ok: true } {
    return { ok: true };
  }
}

async function main(): Promise<void> {
  const { AppModule } = await import('../../src/app.module');
  const { DATABASE } = await import('../../src/core/db/database.module');
  const { configureHttpApp } = await import('../../src/http-app');

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  })
    .overrideProvider(DATABASE)
    .useValue({
      check: async () => undefined,
      db: { transaction: async () => ({ status: 'dead' }) },
    })
    .compile();
  const app = moduleRef.createNestApplication();
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  configureHttpApp(app);
  if (previous === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous;
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  console.log(`LISTENING ${address.port}`);
}

main().catch((error: unknown) => {
  console.error('probe failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
