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
