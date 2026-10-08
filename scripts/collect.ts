import { pool } from '../src/core/db.js';
import { connectors, getConnector } from '../src/connectors/index.js';
import { upsertLots, startRun, finishRun, ensureSources } from '../src/core/repo.js';
import { processarAposColeta } from '../src/core/pos-coleta.js';
import { makeRedis, CHANNEL_UPDATES } from '../src/queue/runtime.js';
import { observerForCollection } from '../src/core/collection-observer.js';
import { executeCollection, type CollectionExecutionDependencies } from '../src/core/collection-execution.js';
import { CollectionCancellationError } from '../src/core/collection-cancellation.js';

const only = process.argv[2];
const limit = Number(process.argv[3] ?? 400);

// Prazo por fonte: só quando COLLECT_TIMEOUT_MS estiver no ambiente. Sem
// default — ausente/0 mantém o comportamento antigo de esperar o conector.
const timeoutMs = process.env.COLLECT_TIMEOUT_MS ? Number(process.env.COLLECT_TIMEOUT_MS) || 0 : 0;

// Recusa cedo: fonte desconhecida ou repetida não chega a abrir run.
const alvo = only ? getConnector(only) : undefined;
if (only && !alvo) {
  console.error(`fonte desconhecida: ${only}`);
  process.exit(1);
}
const targets = only ? [alvo!] : connectors;
const ids = targets.map((c) => c.def.id);
const duplicada = ids.find((id, i) => ids.indexOf(id) !== i);
if (duplicada) {
  console.error(`fonte duplicada na integração: ${duplicada}`);
  process.exit(1);
}

// Shutdown cooperativo: o PRIMEIRO sinal aborta a coleta em andamento (a cadeia
// de AbortController chega no fetch e nos checkpoints) e DEIXA a rotina
// terminar — inclusive o finishRun, que fecha o run no banco. Um segundo sinal
// não espera e sai na hora com 130/143. Nada de process.exit dentro da coleta:
// quem decide o código é a CLI, depois do retorno do executeCollection.
const controller = new AbortController();
let sinalRecebido: NodeJS.Signals | null = null;
const aoReceberSinal = (sinal: NodeJS.Signals) => {
  const codigo = sinal === 'SIGINT' ? 130 : 143;
  if (sinalRecebido) process.exit(codigo);
  sinalRecebido = sinal;
  process.exitCode = codigo;
  controller.abort(new CollectionCancellationError('shutdown'));
  console.error(`[${sinal}] cancelando coleta; aguardando a rotina em andamento`);
};
process.on('SIGINT', () => aoReceberSinal('SIGINT'));
process.on('SIGTERM', () => aoReceberSinal('SIGTERM'));

const pub = makeRedis();
// Mesmo caminho de aviso do worker: a CLI também publica em lot-updates —
// alerta (publishNotification), lances e evento de coleta.
const publicar = (payload: unknown) => pub.publish(CHANNEL_UPDATES, JSON.stringify(payload));

const deps: CollectionExecutionDependencies = {
  lookupConnector: getConnector,
  startRun,
  finishRun,
  upsertLots,
  observerForCollection,
  processarAposColeta,
  publishNotification: publicar,
  logError: (mensagem, erro) => console.error(mensagem, erro),
};

await ensureSources();
const falhas: string[] = [];
for (const c of targets) {
  if (controller.signal.aborted) break;
  const t0 = Date.now();
  try {
    const r = await executeCollection(
      {
        sourceId: c.def.id,
        limit,
        job: 'collect:cli',
        metadata: { origin: 'manual' },
        signal: controller.signal,
        timeoutMs,
        publish: publicar,
      },
      deps,
    );
    const aviso = r.notifications;
    console.log(
      `${c.def.id.padEnd(10)} http=${r.result.httpStatus} lidos=${r.result.fetched} mapeados=${r.result.lots.length} gravados=${r.upserted} descartados=${r.result.skipped} lances=${r.bidChanges.length}` +
        (aviso.disparos ? ` alertas=${aviso.disparos} push=${aviso.push} email=${aviso.emails}/${aviso.pendentesEmail}pend` : '') +
        ` ${(Date.now() - t0) / 1000}s`,
    );
    for (const erro of r.publishErrors) falhas.push(`${c.def.id}: publicação: ${erro}`);
  } catch (err: any) {
    // Sem httpStatus aqui, a tela de cobertura mostra "falhou" sem o código:
    // rodar pela CLI (este script) escondia 302/403/429 que o worker grava.
    const mensagem = String(err?.message ?? err);
    falhas.push(`${c.def.id}: ${mensagem}`);
    console.error(`${c.def.id.padEnd(10)} FALHOU: ${mensagem}`);
    // Prazo estourou numa fonte: registra e segue para a próxima. Shutdown:
    // já não pode iniciar coleta nova.
    if (err instanceof CollectionCancellationError && err.kind === 'shutdown') break;
  }
}
if (falhas.length) {
  console.error(`[collect] ${falhas.length} falha(s):`);
  for (const falha of falhas) console.error(`  - ${falha}`);
}
await pub.quit();
await pool.end();
// Saída explícita: fechar as conexões não bastava. Algum handle (socket do
// undici, timer do ioredis) segurava o loop de eventos, e a coleta ficava
// pendurada para sempre com Postgres e Redis abertos — dez processos assim
// acumularam num dia, e um deles segurava código de 22h antes, pronto para
// regravar lote com o classificador velho quando destravasse.
process.exit(process.exitCode ?? 0);
