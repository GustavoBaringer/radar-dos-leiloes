import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';

test('enviarEmail exige STARTTLS antes de autenticar ou enviar dados', async (t) => {
  const envKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const commands: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.write('220 localhost ESMTP test\r\n');
    let buffered = '';
    socket.on('data', (data) => {
      buffered += data.toString();
      for (let end = buffered.indexOf('\r\n'); end !== -1; end = buffered.indexOf('\r\n')) {
        const command = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        commands.push(command);
        if (/^EHLO /i.test(command)) socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1000000\r\n');
        else if (/^QUIT$/i.test(command)) socket.end('221 bye\r\n');
        else socket.write('500 unsupported\r\n');
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(address.port);
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_USER = 'test-user';
    process.env.SMTP_PASS = 'test-password';
    process.env.SMTP_FROM = 'test@localhost';
    console.warn = (...args: unknown[]) => warnings.push(args);

    const { enviarEmail } = await import('../src/core/notificar.js');
    const result = await enviarEmail([{
      alertId: 1, ownerId: 1, label: 'test', channels: ['email'], email: 'recipient@localhost',
      lotId: 1, title: 'test lot', lotUrl: null, bid: null, source: 'test',
    }]);

    assert.deepEqual(result, { enviados: 0, pendentes: 1 }); // envio falhou sem STARTTLS → fica pendente, não marcado como notificado
    assert.ok(commands.some((command) => /^EHLO /i.test(command)), 'SMTP server should receive EHLO');
    assert.equal(commands.some((command) => /^(AUTH|DATA)(\s|$)/i.test(command)), false,
      `server observed AUTH or DATA without STARTTLS: ${commands.join(' | ')}`);
    assert.ok(warnings.length, 'expected the SMTP failure to be captured by enviarEmail');
  } finally {
    console.warn = originalWarn;
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
