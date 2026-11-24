import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { PLATFORM_ADMIN, REQUIRED_PERMISSION } from '../../src/core/access/access';
import { IS_PUBLIC_KEY } from '../../src/core/auth/public.decorator';

/** Minimal view of Express 5 router internals (Layer objects). */
export interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  /** A mounted sub-router (or middleware function, which has no `stack`). */
  handle?: { stack?: ExpressLayer[] };
}

export interface MountedRoute {
  /** `METHOD /path`; routes inside a nested router are prefixed with `<nested>` because the mount
   * path is not recoverable from Express 5 layers, which guarantees they never match a declared
   * controller route. */
  key: string;
  nested: boolean;
}

/** Recursively collects every route registered on an Express app or router, at any nesting depth. */
export function collectMountedRoutes(stack: ExpressLayer[], nested = false): MountedRoute[] {
  const routes: MountedRoute[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          key: `${method.toUpperCase()} ${nested ? '<nested>' : ''}${layer.route.path}`,
          nested,
        });
      }
    } else if (layer.handle?.stack) {
      routes.push(...collectMountedRoutes(layer.handle.stack, true));
    }
  }
  return routes;
}

/** Routes that exist on the Express app but are not declared by a Nest controller (so no guards). */
export function findUndeclaredRoutes(
  stack: ExpressLayer[],
  declared: ReadonlySet<string>,
): string[] {
  return collectMountedRoutes(stack)
    .map((route) => route.key)
    .filter((key) => !declared.has(key));
}
export function collectControllerRoutes(app: INestApplication) {
  const routes = [];
  for (const nestModule of app.get(ModulesContainer).values()) {
    for (const { metatype: controller } of nestModule.controllers.values()) {
      if (!controller) continue;
      const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[key];
        if (key === 'constructor' || typeof handler !== 'function') continue;
        const segment = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (segment === undefined || requestMethod === undefined) continue;
        const path =
          '/' +
          ['api/v1', prefix ?? '', segment]
            .map((part) => part.replace(/^\/+|\/+$/g, ''))
            .filter(Boolean)
            .join('/');
        const getMetadata = (name: string | symbol): unknown =>
          Reflect.getMetadata(name, handler) ?? Reflect.getMetadata(name, controller);
        routes.push({
          controller,
          method: RequestMethod[requestMethod] ?? String(requestMethod),
          path,
          isPublic: getMetadata(IS_PUBLIC_KEY) === true,
          permission: getMetadata(REQUIRED_PERMISSION),
          platformAdmin: getMetadata(PLATFORM_ADMIN) === true,
        });
      }
    }
  }
  return routes;
}
