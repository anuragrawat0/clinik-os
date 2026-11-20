import { Module } from '@nestjs/common';
import { JobsModule } from './core/jobs/jobs.module';

@Module({ imports: [JobsModule] })
export class WorkerModule {}
