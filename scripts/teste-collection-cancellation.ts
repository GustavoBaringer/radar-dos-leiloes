import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import test from 'node:test';
import {
  CollectionCancellationError,
  collectionDeadlineMs,
  collectionSignal,
  throwIfCancelled,
  withCollectionCancellation,
} from '../src/core/collection-cancellation.js';
import { fetchText } from '../src/connectors/http.js';
import { comNavegador, getJsonViaNavegador } from '../src/connectors/navegador.js';
import { createTenantObserver } from '../src/core/tenant-attempts.js';
import { htmlagenda } from '../src/connectors/htmlagenda.js';

function esperar() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function comServidor(handler: RequestListener, run: (url: string, server: Server) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, server);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

test('requisição ativa aborta pelo sinal compartilhado da coleta, sem retry', async () => {
  let requests = 0;
  const corpo = esperar();
  const fechou = esperar();
  await comServidor((_req, res) => {
    requests++;
    res.writeHead(200);
    res.write('pendente');
    corpo.resolve();
    res.on('close', fechou.resolve);
  }, async (url) => {
    const externo = new AbortController();
    const coleta = withCollectionCancellation({ signal: externo.signal }, () =>
      fetchText(url, { timeoutMs: 3000, retries: 3, gapMs: 0 }),
    );
    await corpo.promise;
    externo.abort(new CollectionCancellationError('shutdown'));
    await assert.rejects(coleta, (err: any) => err instanceof CollectionCancellationError && err.kind === 'shutdown');
    await fechou.promise;
    assert.equal(requests, 1, 'cancelamento não pode gerar nova tentativa');
  });
});

test('laço paginado para na primeira cancelamento', async () => {
  let paginas = 0;
  await comServidor((_req, res) => { res.writeHead(200).end('pagina'); }, async (url) => {
    const externo = new AbortController();
    await assert.rejects(
      withCollectionCancellation({ signal: externo.signal }, async () => {
        for (;;) {
          throwIfCancelled();
          await fetchText(url, { gapMs: 0, retries: 0, timeoutMs: 2000 });
          paginas++;
          if (paginas === 2) externo.abort(new CollectionCancellationError('shutdown'));
        }
      }),
      (err: any) => err instanceof CollectionCancellationError,
    );
    assert.equal(paginas, 2, 'nenhuma página depois do cancelamento');
  });
});

test('laço de tenant HTML falha no primeiro cancelamento e grava budget no ledger', async () => {
  const linhas: { sql: string; params: any[] }[] = [];
  const execute = async (sql: string, params: any[] = []) => {
    linhas.push({ sql, params });
    return [{ id: 7 }];
  };
  const observer = createTenantObserver({ runId: 1, sourceId: 'fixture', origin: 'manual' }, execute);
  let tenants = 0;
  await comServidor(() => { /* nunca responde: só o prazo da coleta derruba */ }, async (url) => {
    await assert.rejects(
      withCollectionCancellation({ timeoutMs: 200 }, async () => {
        for (const host of ['a.example', 'b.example']) {
          tenants++;
          const attempt = await observer.start(host);
          try {
            throwIfCancelled();
            await fetchText(url, { gapMs: 0, retries: 0, timeoutMs: 5000 });
          } catch (error) {
            if (error instanceof CollectionCancellationError) attempt.failure(error.kind === 'deadline' ? 'budget' : 'network');
            else attempt.failure('parser');
            throw error;
          } finally {
            await attempt.finish({ fetched: 0, skipped: 0, returned: 0 });
          }
        }
      }),
      (err: any) => err instanceof CollectionCancellationError && err.kind === 'deadline',
    );
    assert.equal(tenants, 1, 'laço de tenants para no primeiro');
    const update = linhas.find((l) => l.sql.startsWith('UPDATE'));
    assert(update, 'finish deve gravar o attempt');
    assert.equal(update!.params[1], 'failed');
    assert.equal(update!.params[7], 'budget');
  });
});

test('checkpoint real do htmlagenda aborta antes de tocar rede ou banco', async () => {
  const anterior = process.env.HTMLAGENDA_DOMAINS;
  process.env.HTMLAGENDA_DOMAINS = 'a.example,b.example';
  try {
    const externo = new AbortController();
    externo.abort(new CollectionCancellationError('shutdown'));
    await assert.rejects(
      withCollectionCancellation({ signal: externo.signal }, () => htmlagenda.collect({ limit: 5 })),
      (err: any) => err instanceof CollectionCancellationError && err.kind === 'shutdown',
    );
  } finally {
    if (anterior === undefined) delete process.env.HTMLAGENDA_DOMAINS;
    else process.env.HTMLAGENDA_DOMAINS = anterior;
  }
});

test('fetch de navegador já cancelado lança CollectionCancellationError sem tocar na página', async () => {
  const externo = new AbortController();
  externo.abort(new CollectionCancellationError('shutdown'));
  const page = {
    evaluate: async () => { throw new Error('page não deveria ser usado'); },
  } as any;
  await assert.rejects(
    getJsonViaNavegador(page, 'http://127.0.0.1:0/sem-rede', {}, externo.signal),
    CollectionCancellationError,
  );
  // Cancelado antes de abrir: nem procura o Chromium.
  await assert.rejects(
    comNavegador('http://127.0.0.1:0/sem-rede', async () => 1, externo.signal),
    CollectionCancellationError,
  );
});

test('cancelamento depois de concluir não muda resultado pequeno já concluído', async () => {
  await comServidor((_req, res) => { res.writeHead(200).end('ok'); }, async (url) => {
    const externo = new AbortController();
    const resultado = await withCollectionCancellation({ signal: externo.signal, timeoutMs: 60000 }, async () => {
      assert(collectionSignal(), 'contexto ativo dentro de withCollectionCancellation');
      assert.equal(collectionDeadlineMs(), 60000);
      const r = await fetchText(url, { gapMs: 0, retries: 0 });
      return { status: r.status, body: r.body };
    });
    assert.deepEqual(resultado, { status: 200, body: 'ok' });
    externo.abort(new CollectionCancellationError('shutdown'));
    assert.equal(collectionSignal(), undefined, 'contexto já saiu do ALS');
    throwIfCancelled(); // fora do contexto não lança
  });
});
