import { DynamicModule, Module } from '@nestjs/common';
import { AuditWriter } from './audit-writer';

// One DynamicModule per database module object, so every caller gets the same AuditModule instance.
const registered = new WeakMap<DynamicModule, DynamicModule>();

@Module({})
export class AuditModule {
  /** `database` must be the same DynamicModule object the app imports so the pool stays a singleton. */
  static register(database: DynamicModule): DynamicModule {
    let dynamic = registered.get(database);
    if (!dynamic) {
      dynamic = {
        module: AuditModule,
        imports: [database],
        providers: [AuditWriter],
        exports: [AuditWriter],
      };
      registered.set(database, dynamic);
    }
    return dynamic;
  }
}
