import { useEffect, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { Lot } from '@/lib/types';
import {
  EXPLICA_FECHAMENTO, LABEL_ASSET, LABEL_COMB, LABEL_COR, LABEL_DOC, LABEL_PROPERTY,
  LABEL_SELLER, LABEL_STATUS, LABEL_VEHICLE, SRC_LABEL,
} from '@/lib/labels';
import { dataBr, img, money, nopicDe, titulo, whenLabel } from '@/lib/format';
import { BotaoCompartilhar } from './BotaoCompartilhar';

type Par = [string, string | null | undefined];

/**
 * Linha vazia não vira "—": ou o campo some, ou diz por que está vazio.
 * Travessão solto não distingue "a fonte não publica" de "a coleta falhou", e
 * era o que enchia metade do painel.
 */
function LinhasKv({ pares }: { pares: Par[] }) {
  const cheias = pares.filter(([, v]) => v != null && v !== '') as Array<[string, string]>;
  if (!cheias.length) return null;
  return (
    <dl className="kv">
      {cheias.map(([k, v]) => (
        // Endereço e explicação de encerramento passam de 40 caracteres e não
        // cabem numa coluna de quarto de largura: ocupam a linha inteira.
        <div key={k} className={`par${v.length > 40 ? ' largo' : ''}`}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function BlocoKv({ titulo: t, pares }: { titulo: string; pares: Par[] }) {
  if (!pares.some(([, v]) => v != null && v !== '')) return null;
  return (
    <section className="grp">
      <h3>{t}</h3>
      <LinhasKv pares={pares} />
    </section>
  );
}

/**
 * `comoPagina` serve a página pública do lote (link compartilhado): mesmo
 * conteúdo, sem scrim, sem foco preso e sem travar a rolagem do corpo — não é
 * um modal sobre a busca, é a tela inteira. Reaproveitar em vez de duplicar
 * evita a divergência que já aconteceu com o cartão.
 */
export function LotDrawer({ lot, aoFechar, comoPagina = false }: { lot: Lot | null; aoFechar: () => void; comoPagina?: boolean }) {
  const [fotoGrande, setFotoGrande] = useState(0);
  const painel = useRef<HTMLDivElement>(null);
  const botaoFechar = useRef<HTMLButtonElement>(null);

  useEffect(() => setFotoGrande(0), [lot?.id]);

  useEffect(() => {
    if (!lot || comoPagina) return;
    botaoFechar.current?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') aoFechar();
      // Armadilha do foco: sem isto o Tab sai da gaveta modal e passeia pela
      // página atrás dela, que o leitor de tela nem deveria alcançar.
      if (e.key === 'Tab' && painel.current) {
        const alvos = painel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!alvos.length) return;
        const primeiro = alvos[0];
        const ultimo = alvos[alvos.length - 1];
        if (e.shiftKey && document.activeElement === primeiro) {
          e.preventDefault();
          ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
          e.preventDefault();
          primeiro.focus();
        }
      }
    };
    document.addEventListener('keydown', tecla);
    // A página de trás não pode rolar sob a gaveta aberta.
    const antes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', tecla);
      document.body.style.overflow = antes;
    };
  }, [lot, aoFechar, comoPagina]);

  if (!lot) return null;

  const when = whenLabel(lot);
  const lance = lot.current_bid ?? lot.min_bid;
  const rotuloLance = lot.current_bid != null ? 'Lance atual' : 'Lance mínimo';
  const desconto =
    !lot.bid_suspect && lot.appraisal && lance != null && lot.appraisal > lance
      ? Math.round((1 - lance / lot.appraisal) * 100)
      : null;

  const chips: Array<[string, string]> = [];
  if (lot.current_bid != null && lot.min_bid != null) chips.push(['Mínimo', money(lot.min_bid)!]);
  if (lot.bid_increment != null) chips.push(['Incremento', money(lot.bid_increment)!]);
  if (lot.fees_pct) chips.push(['Comissão', `${lot.fees_pct}%`]);

  // O Set sozinho não deduplica "CURITIBA - PR" contra "Curitiba - PR": a
  // fonte grava o pátio em caixa alta e a cidade normalizada vem em caixa
  // mista. A chave de comparação ignora caixa, acento e pontuação; o que
  // aparece na tela é a primeira grafia, que é a mais legível.
  const chave = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const local = (() => {
    const partes = [lot.yard, [lot.city, lot.state].filter(Boolean).join(' - ')].filter((v): v is string => Boolean(v));
    const vistos = new Set<string>();
    return partes.filter((v) => !vistos.has(chave(v)) && vistos.add(chave(v))).join(' · ');
  })();
  // Só http(s): `javascript:` num campo vindo da fonte vira execução ao clique.
  const urlSegura = /^https?:\/\//.test(lot.lot_url ?? '') ? lot.lot_url! : null;
  const fotos = lot.photos ?? [];

  const corpo = (
    <>
        <header className="painel-topo">
          <div>
            <h2 id="drawerTitle" title={lot.title_raw}>
              {titulo(lot)}
            </h2>
            <div className="painel-sub">
              <span className={`pill ${when.cls}`}>{when.text}</span>
              <span className="pill quieto">{LABEL_STATUS[lot.status] ?? lot.status}</span>
              <span className="pill quieto">{SRC_LABEL[lot.source_id] ?? lot.source_id}</span>
              {lot.doc_type && <span className="pill quieto">{LABEL_DOC[lot.doc_type] ?? lot.doc_type}</span>}
            </div>
          </div>
          <div className="painel-acoes">
            {/* A descrição acompanha o compartilhamento nativo: sem ela, o
                WhatsApp mostra só a URL crua até buscar o preview. */}
            <BotaoCompartilhar
              titulo={titulo(lot)}
              descricao={`${titulo(lot)} em leilão${lot.city ? ` — ${lot.city}/${lot.state}` : ''}`}
            />
            {!comoPagina && (
              <button ref={botaoFechar} className="ico-fechar" onClick={aoFechar} aria-label="Fechar detalhe do lote">
                <X size={20} aria-hidden />
              </button>
            )}
          </div>
        </header>

        <div className="painel-corpo">
          <div className="col-midia">
            <figure className="foto-grande">
              <img
                src={fotos.length ? img(fotos[fotoGrande], 1200) : nopicDe(lot)}
                className={fotos.length ? '' : 'is-nopic'}
                alt={fotos.length ? `Foto ${fotoGrande + 1} de ${titulo(lot)}` : 'Lote sem foto disponível'}
              />
              {lot.auctioneer_name && (
                <figcaption className="cred-foto">foto: {lot.auctioneer_name}</figcaption>
              )}
            </figure>
            {fotos.length > 1 && (
              <div className="galeria">
                {fotos.slice(0, 18).map((p, i) => (
                  <button
                    key={p}
                    type="button"
                    className={`thumb-pick${i === fotoGrande ? ' on' : ''}`}
                    onClick={() => setFotoGrande(i)}
                    aria-label={`Ver foto ${i + 1}`}
                    aria-pressed={i === fotoGrande}
                  >
                    <img loading="lazy" src={img(p, 180)} alt="" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="col-dados">
            <div className="preco">
              <div className="preco-lbl">{rotuloLance}</div>
              <div className={`preco-v mono${lance == null ? ' vazio' : ''}`}>
                {lance != null ? money(lance) : 'a fonte não publica valor para este lote'}
              </div>
              {desconto != null && (
                <div className="preco-desc">
                  <b>{desconto}% abaixo</b> da avaliação de {money(lot.appraisal)}{' '}
                  <span className="nota">— avaliação não é preço de venda</span>
                </div>
              )}
              {lot.bid_suspect && (
                <div className="preco-alerta">
                  A fonte publicou um valor fora de faixa plausível. Confira no site do leiloeiro
                  antes de decidir.
                </div>
              )}
              {chips.length > 0 && (
                <div className="preco-chips">
                  {chips.map(([k, v]) => (
                    <span key={k}>
                      <i>{k}</i>
                      <b className="mono">{v}</b>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {urlSegura ? (
              <a className="open-src" href={urlSegura} target="_blank" rel="noopener noreferrer">
                Abrir no site do leiloeiro <ExternalLink size={15} aria-hidden />
              </a>
            ) : (
              <p className="sem-link">A fonte não publica link direto para este lote.</p>
            )}

            <BlocoKv
              titulo="Quando e onde"
              pares={[
                ['Início do leilão', dataBr(lot.auction_start_utc)],
                ['Encerramento', dataBr(lot.auction_end_utc) ?? EXPLICA_FECHAMENTO[lot.closing_model] ?? 'não publicado por lote'],
                ['Localização', local || null],
              ]}
            />

            <BlocoKv
              titulo="O bem"
              pares={[
                ['Tipo', LABEL_ASSET[lot.asset_type] ?? lot.asset_type],
                [
                  'Categoria',
                  lot.vehicle_type
                    ? (LABEL_VEHICLE[lot.vehicle_type] ?? lot.vehicle_type)
                    : lot.property_type
                      ? (LABEL_PROPERTY[lot.property_type] ?? lot.property_type)
                      : null,
                ],
                ['Ano', lot.year_model ? `${lot.year_make ?? ''}${lot.year_make ? '/' : ''}${lot.year_model}` : null],
                ['Quilometragem', lot.km != null ? `${lot.km.toLocaleString('pt-BR')} km` : null],
                ['Área', lot.area ? `${lot.area} m²` : null],
                ['Cor', lot.color ? (LABEL_COR[lot.color] ?? lot.color) : null],
                ['Combustível', lot.fuel ? (LABEL_COMB[lot.fuel] ?? lot.fuel) : null],
                ['Placa', lot.plate_masked],
              ]}
            />

            <BlocoKv
              titulo="Quem vende"
              pares={[
                ['Leiloeiro', [lot.auctioneer_name, lot.auctioneer_reg].filter(Boolean).join(' — ') || null],
                ['Comitente', lot.seller_name],
                ['Tipo de comitente', lot.seller_type ? (LABEL_SELLER[lot.seller_type] ?? lot.seller_type) : null],
              ]}
            />

            {lot.bid_history?.length ? (
              <section className="grp">
                <h3>Histórico de lance observado</h3>
                <div className="hist">
                  {lot.bid_history.map((h) => (
                    <div key={h.observed_at}>
                      <span className="mono">{money(h.bid)}</span>
                      <span className="quando">{dataBr(h.observed_at)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <details className="proc">
              <summary>Procedência do dado</summary>
              <LinhasKv
                pares={[
                  ['Fonte', SRC_LABEL[lot.source_id] ?? lot.source_id],
                  ['Classificação na fonte', lot.source_category ?? 'a fonte não classifica'],
                  ['Título publicado pela fonte', lot.title_display && lot.title_display !== lot.title_raw ? lot.title_raw : null],
                  ['Modelo de encerramento', EXPLICA_FECHAMENTO[lot.closing_model] ?? lot.closing_model],
                  ['Fuso publicado pela fonte', lot.source_tz],
                  ['Entrou na base em', dataBr(lot.first_seen_at)],
                  ['Coletado em', dataBr(lot.collected_at)],
                ]}
              />
            </details>
          </div>
        </div>
    </>
  );

  // Página pública: o mesmo conteúdo sem o aparato de modal.
  if (comoPagina) return <main className="faixa lote-pagina">{corpo}</main>;

  return (
    <div className="drawer open" role="dialog" aria-modal="true" aria-labelledby="drawerTitle">
      <div className="scrim" onClick={aoFechar} />
      <div className="painel" ref={painel}>
        {corpo}
      </div>
    </div>
  );
}
