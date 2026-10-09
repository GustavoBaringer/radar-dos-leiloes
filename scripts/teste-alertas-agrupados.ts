import test from 'node:test';
import assert from 'node:assert/strict';
import { agruparDisparos, mensagemResumo } from '../src/core/alerta-resumo.js';
import { avaliarAlertas, type Disparo } from '../src/core/alerts.js';
import { enviarPush, enviarEmail } from '../src/core/notificar.js';
import type { query } from '../src/core/db.js';

const disparo = (lotId: number, alertId = 1, ownerId = 7): Disparo => ({
  lotId, alertId, ownerId, label: 'SUV até 50 mil', channels: ['sino', 'push', 'email'],
  email: `owner${ownerId}@example.test`, title: `Veículo ${lotId}`, lotUrl: `https://example.test/lote/${lotId}`,
  bid: 10000, source: 'teste',
});
const dez = () => Array.from({ length: 10 }, (_, i) => disparo(i + 1));
const subscription = (endpoint: string, owner_id = 7) => ({ endpoint, owner_id, p256dh: 'key', auth: 'auth' });

function pushFixture(subscriptions = [subscription('aparelho')], failed: string[] = []) {
  const sent: Array<{ endpoint: string; payload: any }> = [];
  const marked: unknown[][] = [];
  const updates: Array<{ sql: string; params: any[] }> = [];
  return {
    sent, marked, updates,
    deps: {
      enabled: true,
      query: (async (sql: string, params: any[] = []) => {
        if (sql.startsWith('SELECT')) return subscriptions;
        updates.push({ sql, params }); return [];
      }) as typeof query,
      send: (async (sub: any, payload: any) => {
        if (failed.includes(sub.endpoint)) throw { statusCode: sub.endpoint === 'morto' ? 410 : 503 };
        sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
        return { statusCode: 201, body: '', headers: {} };
      }),
      mark: async (...args: [number, number, string]) => { marked.push(args); },
    },
  };
}

test('agrupa por dono e ID do alerta, sem duplicar lotes ou confundir nomes iguais', () => {
  const input = [...dez(), disparo(1), disparo(11, 2), disparo(12, 1, 8)];
  assert.deepEqual(agruparDisparos(input).map((g) => g.length), [10, 1, 1]);
  assert.equal(input.length, 13);
  assert.equal(mensagemResumo('X', 1), 'Encontramos 1 novo lote para o seu alerta "X"');
});

test('10 lotes geram um push por aparelho do dono e marcam todos os lotes entregues', async () => {
  const f = pushFixture([subscription('celular'), subscription('desktop'), subscription('outro', 8)]);
  assert.equal(await enviarPush([...dez(), disparo(1)], f.deps), 2);
  assert.deepEqual(f.sent.map((s) => s.endpoint), ['celular', 'desktop']);
  assert.deepEqual(f.sent[0].payload, {
    title: 'Radar', body: 'Encontramos 10 novos lotes para o seu alerta "SUV até 50 mil"',
    url: '/alertas?alertId=1', tag: 'alerta-1-1',
  });
  assert.equal(f.marked.length, 10);
  assert(f.marked.every((m) => m[2] === 'push'));
});

test('alertas distintos, mesmo com nome igual, recebem resumos separados', async () => {
  const f = pushFixture();
  await enviarPush([...dez(), disparo(11, 2)], f.deps);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].payload.body, /1 novo lote/);
  assert.equal(f.sent[1].payload.url, '/alertas?alertId=2');
});

test('sem aparelho, sem push ou sem VAPID não envia nem marca entrega', async () => {
  const f = pushFixture([]);
  assert.equal(await enviarPush(dez(), f.deps), 0);
  f.deps.enabled = false;
  assert.equal(await enviarPush(dez(), f.deps), 0);
  f.deps.enabled = true;
  assert.equal(await enviarPush(dez().map((d) => ({ ...d, channels: ['sino'] })), f.deps), 0);
  assert.equal(f.marked.length, 0);
});

test('falha em todos os aparelhos não marca; inscrição 410 é removida', async () => {
  const f = pushFixture([subscription('morto'), subscription('falha')], ['morto', 'falha']);
  assert.equal(await enviarPush(dez(), f.deps), 0);
  assert.equal(f.marked.length, 0);
  assert.match(f.updates[0].sql, /DELETE/);
  assert.match(f.updates[1].sql, /failures = failures \+ 1/);
});

test('sucesso em um aparelho marca o grupo mesmo com falha em outro', async () => {
  const f = pushFixture([subscription('falha'), subscription('ok')], ['falha']);
  assert.equal(await enviarPush(dez(), f.deps), 1);
  assert.equal(f.marked.length, 10);
});

test('e-mail agrupa 10 lotes, protege HTML e mantém texto simples', async () => {
  const sent: any[] = [], marked: unknown[][] = [];
  const input = dez();
  input[0] = { ...input[0], label: '<SUV>', title: '<script>teste</script>', lotUrl: 'javascript:alert(1)' };
  const result = await enviarEmail(input, {
    env: { SMTP_HOST: 'smtp.test' }, send: async (mail) => { sent.push(mail); },
    mark: async (...args) => { marked.push(args); },
  });
  assert.deepEqual(result, { enviados: 1, pendentes: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'Radar: Encontramos 10 novos lotes para o seu alerta "<SUV>"');
  assert.equal((sent[0].html.match(/<li>/g) ?? []).length, 10);
  assert(!sent[0].html.includes('<script>'));
  assert(!sent[0].html.includes('javascript:'));
  assert.match(sent[0].html, /&lt;SUV&gt;/);
  assert.match(sent[0].text, /Veículo 10/);
  assert.equal(marked.length, 10);
});

test('SMTP ausente e envio com falha contam resumos pendentes e não marcam lotes', async () => {
  let marks = 0;
  const deps = { env: {}, send: async () => { throw Error('smtp indisponível'); }, mark: async () => { marks++; } };
  const input = [...dez(), disparo(11, 2)];
  assert.deepEqual(await enviarEmail(input, deps), { enviados: 0, pendentes: 2 });
  deps.env = { SMTP_HOST: 'smtp.test' };
  assert.deepEqual(await enviarEmail(input, deps), { enviados: 0, pendentes: 2 });
  assert.equal(marks, 0);
});

test('casamento processa mais de 50 lotes e retorna só hits novos em reavaliações', async () => {
  const lots = Array.from({ length: 75 }, (_, i) => ({ id: i + 1, title_raw: `Lote ${i + 1}`, source_id: 'teste' }));
  const hits = new Set<number>([1]);
  const queryFn = (async (sql: string, params: any[]) => {
    if (sql.includes('FROM alerts')) return [{ id: 1, owner_id: 7, created_at: '2026-10-01', label: 'X', q: null, filters: {}, channels: ['push'], email: null }];
    if (sql.includes('FROM lots')) {
      assert(!sql.includes('LIMIT 50'));
      assert.match(sql, /first_seen_at >= \$2::timestamptz/);
      assert.match(sql, /status NOT IN/);
      return lots;
    }
    if (sql.includes('INSERT INTO alert_hits')) {
      assert.match(sql, /ON CONFLICT \(alert_id, lot_id\) DO NOTHING/);
      const inserted = params[1].filter((id: number) => !hits.has(id));
      inserted.forEach((id: number) => hits.add(id));
      return inserted.map((lot_id: number) => ({ lot_id }));
    }
    if (sql.startsWith('UPDATE alerts')) return [];
    throw Error(`unexpected SQL: ${sql}`);
  }) as typeof query;
  const first = await avaliarAlertas(lots.map((l) => l.id), queryFn);
  assert.equal(first.length, 74);
  assert.equal(agruparDisparos(first)[0].length, 74);
  assert.equal((await avaliarAlertas(lots.map((l) => l.id), queryFn)).length, 0);
});

test('clique no push navega a aba existente até os resultados antes de focar', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const handlers = new Map<string, (event: any) => void>();
  const calls: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  runInNewContext(readFileSync(new URL('../src/web/sw.js', import.meta.url), 'utf8'), {
    URL,
    self: { location: { origin: 'https://radar.test' }, addEventListener: (type: string, handler: any) => handlers.set(type, handler) },
    clients: {
      matchAll: async () => [{ url: 'https://radar.test/busca',
        navigate: async (url: string) => { calls.push(url); return { focus: async () => { calls.push('focus'); } }; },
        focus: async () => { calls.push('focus antigo'); },
      }],
      openWindow: async () => { throw Error('não deveria abrir outra aba'); },
    },
  });
  handlers.get('notificationclick')!({
    notification: { close: () => {}, data: { url: '/alertas?alertId=1' } },
    waitUntil: (promise: Promise<unknown>) => { pending = promise; },
  });
  await pending;
  assert.deepEqual(calls, ['/alertas?alertId=1', 'focus']);
});
