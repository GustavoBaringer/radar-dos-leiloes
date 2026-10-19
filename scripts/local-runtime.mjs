const rawPort = process.env.PORT ?? '4500';
const port = Number(rawPort);

if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT for local runtime: ${rawPort}`);
}

process.env.BIND_HOST = '127.0.0.1';
process.env.NEST_BOOTSTRAP = '1';
process.env.SITE_URL = `http://127.0.0.1:${port}`;
