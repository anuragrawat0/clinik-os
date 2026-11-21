/**
 * Custom Next.js server. It exists for one reason: to overwrite X-Forwarded-For with the real TCP
 * peer before Next's /api rewrite proxies the request (see server/peer-forwarding.ts). Routing,
 * rewrites and pages are otherwise unchanged. `--dev` runs Next in development mode.
 */
import { createServer } from 'node:http';
import next from 'next';
import { applyPeerAsForwardedFor } from './server/peer-forwarding';

const dev = process.argv.includes('--dev');
const hostname = '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const app = next({ dev, hostname, port });
const handleRequest = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const handleUpgrade = app.getUpgradeHandler();
    const server = createServer((request, response) => {
      applyPeerAsForwardedFor(request);
      void handleRequest(request, response);
    });
    server.on('upgrade', (request, socket, head) => {
      applyPeerAsForwardedFor(request);
      void handleUpgrade(request, socket, head);
    });
    server.listen(port, hostname, () => {
      console.log(`web listening on http://${hostname}:${port} (${dev ? 'dev' : 'production'})`);
    });
  })
  .catch((error: unknown) => {
    console.error('web startup failed', error instanceof Error ? error.name : 'UnknownError');
    process.exitCode = 1;
  });
