import { getConnector } from '../connectors/index.js';
import type { CollectOptions, CollectResult } from '../connectors/types.js';

/**
 * Coleta de UM tenant — API preparada no Step4, ainda SEM portão de execução
 * (o Step5 decide quem pode chamar e quando). Não mexe na fila, não agenda
 * cron nem dispara por domínio: apenas repassa `tenant` ao conector, que
 * continua dono do parser e dos filtros de origem.
 *
 * `tenant` é host explícito; `sourceId` é a fonte de sempre. Se o host não
 * estiver na população elegível da fonte, o conector recusa (nunca vira
 * "coletar tudo").
 */
export async function collectTenant(sourceId: string, tenant: string, options: CollectOptions): Promise<CollectResult> {
  const conector = getConnector(sourceId);
  if (!conector) throw new Error(`Conector desconhecido: ${sourceId}`);
  const alvo = String(tenant ?? '').trim();
  if (!alvo) throw new Error('tenant é obrigatório');
  return conector.collect({ ...options, tenant: alvo });
}
