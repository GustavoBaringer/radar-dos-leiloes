/**
 * DECISÃO TEMPORÁRIA — 2026-10-12, dono do projeto.
 *
 * O navegador deixou de parear as fotos: antes cada cartão esperava a vez
 * anterior para chamar `/api/img` (dois por vez), porque o servidor só
 * processava dois jobs de imagem ao mesmo tempo. Esse teto não existe mais — nem
 * no servidor (`src/core/antibot/resources.ts` e `images.ts`, que agora deixam
 * `/api/img` passar sem limite de requisições) — então a fila vira passe direto:
 * `enqueue()` chama `begin()` na hora e o cancelador não faz nada.
 *
 * As retentativas com espera de `ImagemCartao.tsx` continuam valendo: elas
 * tratam origem fora do ar, não limitam requisição.
 *
 * Risco assumido: uma página com muitos visíveis abre dezenas de downloads e
 * processamentos de sharp ao mesmo tempo, o que pode derrubar o container web.
 * O custo é conhecido e aceito por enquanto. Como reverter: restaurar a fila
 * com `limit = 2` (o corpo antigo está no histórico deste arquivo) e os tetos
 * de jobs no servidor.
 */
export function createImageQueue() {
  const release = () => {};
  return {
    enqueue(begin: (release: () => void) => void) {
      begin(release);
      return () => {};
    },
  };
}
export const cardImageQueue = createImageQueue();
