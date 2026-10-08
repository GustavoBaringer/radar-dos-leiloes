import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBootstrapLifecycle } from './bootstrap/lifecycle.js';

const lifecycle = createBootstrapLifecycle((error) => {
  console.error('Falha ao encerrar o servidor:', error);
  process.exitCode = 1;
});

let startupFinished = false;
let shutdownRequested = false;
const startupCancelled = new Error('Bootstrap cancelled by shutdown signal');
const onShutdown = () => {
  shutdownRequested = true;
  if (startupFinished) void lifecycle.close().catch((error) => lifecycle.reportCleanupFailure(error));
};
process.once('SIGINT', onShutdown);
process.once('SIGTERM', onShutdown);

function ensureStartupActive() {
  if (shutdownRequested) throw startupCancelled;
}

function closeTlsServer(server: import('node:https').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function start() {
  try {
    const { resolveHttpPaths } = await import('./bootstrap/paths.js');
    ensureStartupActive();
    const paths = resolveHttpPaths(import.meta.url);
    const oidc = await import('./core/oidc.js');
    ensureStartupActive();
    if (!oidc.oidcLigado()) throw new Error('FATAL: OIDC desligado. Configure OIDC_ISSUER/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET no ambiente.');

    const { createHttpDependencies } = await import('./bootstrap/http-dependencies.js');
    const dependencies = await createHttpDependencies(oidc);
    ensureStartupActive();
    const { createLegacyHost } = await import('./legacy-host.js');
    const { app, initializeResources } = await createLegacyHost({ env: process.env, paths, dependencies });
    lifecycle.setHttpClose(() => app.close());
    ensureStartupActive();
    await initializeResources();
    ensureStartupActive();

    const port = Number(process.env.PORT ?? 4500);
    const host = process.env.BIND_HOST ?? '127.0.0.1';
    await app.listen({ port, host });
    ensureStartupActive();
    console.log(`API e interface em http://localhost:${port}`);

    const certDir = paths.certDir;
    const temCert = existsSync(join(certDir, 'local.crt')) && existsSync(join(certDir, 'local.key'));
    if (!temCert) { startupFinished = true; return; }

    // TLS is a production-only terminator in front of the same Fastify host.
    const { createServer } = await import('node:https');
    const { request: httpRequest } = await import('node:http');
    ensureStartupActive();
    const tlsPort = port + 1;
    const tls = createServer({
      key: readFileSync(join(certDir, 'local.key')),
      cert: existsSync(join(certDir, 'ca.crt'))
        ? Buffer.concat([readFileSync(join(certDir, 'local.crt')), readFileSync(join(certDir, 'ca.crt'))])
        : readFileSync(join(certDir, 'local.crt')),
    }, (req, res) => {
      const upstream = httpRequest({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end('origem indisponível'); });
      req.pipe(upstream);
    });
    lifecycle.setTlsClose(() => closeTlsServer(tls));
    tls.on('connection', (socket) => lifecycle.trackSocket(socket));
    tls.on('upgrade', (req, socket, head) => {
      const upstream = httpRequest({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers });
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        const headers = Object.entries(response.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`).join('');
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? 'Switching Protocols'}\r\n${headers}\r\n`);
        if (upstreamHead?.length) socket.write(upstreamHead);
        if (head?.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket); upstreamSocket.pipe(socket);
        const close = () => { socket.destroy(); upstreamSocket.destroy(); };
        socket.on('error', close); upstreamSocket.on('error', close);
        socket.on('close', close); upstreamSocket.on('close', close);
      });
      upstream.on('error', () => socket.destroy());
      upstream.end();
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      tls.once('error', onError);
      tls.listen(tlsPort, host, () => {
        tls.off('error', onError);
        resolve();
      });
    });
    ensureStartupActive();
    tls.on('error', (error) => {
      console.error('Falha no terminador TLS:', error);
      process.exitCode = 1;
      onShutdown();
    });
    console.log(`HTTPS (certificado próprio) em https://localhost:${tlsPort}`);
    startupFinished = true;
  } catch (error) {
    if (error === startupCancelled) {
      try { await lifecycle.close(); }
      catch (cleanupError) { lifecycle.reportCleanupFailure(cleanupError); }
      return;
    }
    process.exitCode = 1;
    await lifecycle.failStartup(error);
  }
}

await start();
