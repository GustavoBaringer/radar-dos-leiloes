import assert from 'node:assert/strict';
import { collectSuaPlataforma } from '../src/connectors/suaplataforma.js';
import { CollectionCancellationError, withCollectionCancellation } from '../src/core/collection-cancellation.js';

const previousDomains = process.env.SUAPLATAFORMA_DOMAINS;
process.env.SUAPLATAFORMA_DOMAINS = 'www.gracieleiloes.com.br';

function lote(id: number, active = false) {
  return {
    ID_Leiloes_Lote: id,
    Lote: `Imóvel residencial exemplo ${id}`,
    Categoria: 'Residenciais',
    URLlote: `/lote/${id}`,
    GetLoteRealTime: [{ Lote_SubStatus_Label: active ? 'Aberto para lance' : 'Leilão encerrado' }],
  };
}

function tracker() {
  const attempts: Array<{ domain: string; responses: number[]; failures: string[]; stats?: any }> = [];
  const observer = {
    async start(domain: string) {
      const item = { domain, responses: [] as number[], failures: [] as string[], stats: undefined as any };
      attempts.push(item);
      return {
        response: (status: number) => item.responses.push(status),
        failure: (kind = 'network') => item.failures.push(kind),
        finish: async (stats: any) => { item.stats = stats; },
      };
    },
  };
  return { observer, attempts };
}

async function main() {
  try {
    let requested: string[] = [];
    const gracie = tracker();
    const emptyHistory = Array.from({ length: 200 }, (_, i) => lote(i + 1));
    const result = await collectSuaPlataforma({ limit: 1000, tenant: 'www.gracieleiloes.com.br', observer: gracie.observer }, {
      query: async () => { throw new Error('env population should avoid query'); },
      fetchJson: async (url) => {
        requested.push(url);
        return { status: 200, data: { CountTotal: 1671, Lotes: emptyHistory }, raw: '' };
      },
    });
    assert.equal(result.fetched, 200);
    assert.equal(result.skipped, 200);
    assert.equal(result.lots.length, 0);
    assert.match(requested[0], /^https:\/\/www\.gracieleiloes\.com\.br\//);
    assert.equal(gracie.attempts[0].domain, 'gracieleiloes.com.br');
    assert.deepEqual(gracie.attempts[0].stats, { fetched: 200, skipped: 200, returned: 0, truncated: false });

    process.env.SUAPLATAFORMA_DOMAINS = 'gracieleiloes.com.br,inovaleiloes.com.br';
    requested = [];
    const inova = tracker();
    const inovaResult = await collectSuaPlataforma({ limit: 100, tenant: 'www.inovaleiloes.com.br', observer: inova.observer }, {
      query: async () => { throw new Error('env population should avoid query'); },
      fetchJson: async (url) => {
        requested.push(url);
        const page = Number(url.match(/GetLotes\/(\d+)/)?.[1]);
        return { status: 200, data: { CountTotal: 5451, Lotes: page === 1 ? [lote(4774, true), ...Array.from({ length: 199 }, (_, i) => lote(i + 1))] : [lote(9000)] }, raw: '' };
      },
    });
    assert.equal(inovaResult.lots.length, 1);
    assert.equal(inovaResult.lots[0].externalId, 'www.inovaleiloes.com.br:4774');
    assert.equal(requested.length, 2);
    assert.deepEqual(inova.attempts[0].stats, { fetched: 201, skipped: 200, returned: 1, truncated: false });

    let calls = 0;
    await assert.rejects(() => collectSuaPlataforma({ limit: 10, tenant: 'attacker.example' }, {
      query: async () => [{ domain: 'gracieleiloes.com.br' }],
      fetchJson: async () => { calls++; throw new Error('must not request'); },
    }), /fora da população elegível/);
    assert.equal(calls, 0);

    const malformed = tracker();
    await collectSuaPlataforma({ limit: 10, tenant: 'gracieleiloes.com.br', observer: malformed.observer }, {
      query: async () => [],
      fetchJson: async () => ({ status: 200, data: { nope: [] }, raw: '' }),
    });
    assert.deepEqual(malformed.attempts[0].failures, ['parser']);
    assert.equal(malformed.attempts[0].stats.truncated, false);

    const network = tracker();
    await collectSuaPlataforma({ limit: 10, tenant: 'gracieleiloes.com.br', observer: network.observer }, {
      query: async () => [],
      fetchJson: async () => { throw new Error('offline'); },
    });
    assert.deepEqual(network.attempts[0].failures, ['network']);

    const cancelled = tracker();
    await assert.rejects(() => withCollectionCancellation({ timeoutMs: 1 }, () => collectSuaPlataforma({
      limit: 10, tenant: 'gracieleiloes.com.br', observer: cancelled.observer,
    }, {
      query: async () => [],
      fetchJson: async () => new Promise((_resolve, reject) => setTimeout(() => reject(new CollectionCancellationError('deadline')), 5)),
    })), CollectionCancellationError);
    assert.deepEqual(cancelled.attempts[0].failures, ['budget']);
    assert.ok(cancelled.attempts[0].stats);

    const limited = tracker();
    const limitedResult = await collectSuaPlataforma({ limit: 1, tenant: 'gracieleiloes.com.br', observer: limited.observer }, {
      query: async () => [],
      fetchJson: async () => ({ status: 200, data: { CountTotal: 2, Lotes: [lote(1, true), lote(2, true)] }, raw: '' }),
    });
    assert.equal(limitedResult.lots.length, 1);
    assert.equal(limited.attempts[0].stats.truncated, true);
    console.log('SuaPlataforma tenant checks passed');
  } finally {
    if (previousDomains === undefined) delete process.env.SUAPLATAFORMA_DOMAINS;
    else process.env.SUAPLATAFORMA_DOMAINS = previousDomains;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
