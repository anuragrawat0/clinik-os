import { loadApiConfig } from './core/config/config';
import { DatabaseModule } from './core/db/database.module';
import { IdentityCoreModule } from './modules/identity/core/identity-core.module';

/**
 * Leaf file (imports nothing from app.module) holding the module objects that must be shared by
 * identity: a second DatabaseModule.forRuntimeRole(...) object would open a second connection pool.
 * Feature modules import `database` / `identityCore` from here, never from app.module.ts.
 */
export const apiConfig = loadApiConfig();

export const database = DatabaseModule.forRuntimeRole(
  apiConfig.DATABASE_URL,
  'clinic_app',
  'clinik-api',
);

export const identityCore = IdentityCoreModule.register({
  database,
  trustedProxyCidrs: apiConfig.TRUSTED_PROXY_CIDRS,
});
