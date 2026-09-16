/**
 * Um cartão de lote só, para a busca e para a home.
 *
 * Ele nasceu duplicado em app.js e landing.js e as cópias divergiram em
 * silêncio: a home ficou sem crédito de foto, sem selo de desconto, com o
 * título cru da fonte e com o id interno ("vlance", "leilaopro") no lugar do
 * nome. Quem mexer no cartão mexe aqui, uma vez.
 */
window.Cartao = (() => {
  /**
   * Todo texto vindo da fonte passa por aqui antes de entrar em innerHTML.
   * O título do lote é escrito pelo leiloeiro: basta uma fonte publicar
   * `<img onerror=...>` num título para virar execução de script na nossa tela.
   */
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** Foto servida pela nossa origem: o navegador recusa a do Kuss (ORB). */
  const img = (url, w) => `/api/img?u=${encodeURIComponent(url)}${w ? `&w=${w}` : ''}`;
  const NOPIC = '/nopic.svg';
  const NOPIC_IMOVEL = '/nopic-imovel.svg';
  /** Silhueta de carro num anúncio de imóvel lê mal; o placeholder segue o tipo do bem. */
  const nopicDe = (lot) => (lot.asset_type === 'imovel' ? NOPIC_IMOVEL : NOPIC);

  /**
   * Rede, origem fora do ar ou formato recusado pelo navegador: em todos os casos
   * o cartão precisa mostrar algo. O guard `dataset.fallback` evita laço infinito
   * caso o próprio nopic falhe.
   */
  function attachImgFallback(root) {
    for (const el of root.querySelectorAll('img')) {
      el.addEventListener('error', () => {
        if (el.dataset.fallback === 'yes') return;
        el.dataset.fallback = 'yes';
        el.classList.add('is-nopic');
        el.src = NOPIC;
      });
    }
  }

  const money = (v) =>
    v == null ? null : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

  /** Nome de exibição de toda fonte que existe no índice — id cru na tela é vazamento de implementação. */
  const SRC_LABEL = {
    superbid: 'Superbid', copart: 'Copart', leilo: 'Leilo', kuss: 'Kuss', caixa: 'Caixa',
    vlance: 'vLance', soleon: 'SOLEON', freitas: 'Freitas', leilaopro: 'Leilão PRO',
  };
  const LABEL_DOC = {
    judicial: 'Judicial', extrajudicial: 'Extrajudicial',
    recuperado_financiamento: 'Recuperado de financiamento', sinistrado: 'Sinistrado',
    sucata: 'Sucata', frota: 'Frota / locadora', conservado: 'Conservado',
  };
  const LABEL_VEHICLE = {
    carro: 'Carro', suv: 'SUV', picape: 'Picape', moto: 'Moto', caminhao: 'Caminhão',
    onibus: 'Ônibus', utilitario: 'Utilitário / Van', maquina: 'Máquina', reboque: 'Reboque',
    nautico: 'Náutico', peca: 'Peça', outro: 'Outro',
  };
  const LABEL_PROPERTY = {
    apartamento: 'Apartamento', casa: 'Casa / sobrado', terreno: 'Terreno / lote',
    comercial: 'Comercial', rural: 'Rural', vaga: 'Vaga de garagem', outro: 'Outro',
  };

  /** O título da fonte continua guardado; o de exibição é o padronizado. */
  const titulo = (lot) => lot.title_display || lot.title_raw;

  /**
   * O rótulo de tempo muda conforme o modelo de encerramento da fonte.
   * Pregão ao vivo não tem fim por lote: mostrar contagem regressiva ali seria mentira.
   */
  function whenLabel(lot) {
    const now = Date.now();
    if (lot.closing_model === 'timer_por_lote' && lot.auction_end_utc) {
      const diff = new Date(lot.auction_end_utc).getTime() - now;
      if (diff <= 0) return { text: 'Encerrado', cls: 'nodate' };
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const d = Math.floor(h / 24);
      if (d >= 1) return { text: `Encerra em ${d}d ${h % 24}h`, cls: '' };
      if (h >= 1) return { text: `Encerra em ${h}h ${m}min`, cls: 'soon' };
      return { text: `Encerra em ${m} min`, cls: 'hot' };
    }
    if (lot.auction_start_utc) {
      const start = new Date(lot.auction_start_utc);
      const label = start.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const prefix = lot.closing_model === 'sequencial' ? 'Pregão sequencial' : 'Pregão';
      return { text: `${prefix} em ${label}`, cls: start.getTime() - now < 86400000 ? 'soon' : '' };
    }
    return { text: 'Sem data de leilão definida', cls: 'nodate' };
  }

  /** Crédito sobre a foto. O crédito acompanha a imagem, e a imagem aparece no cartão e no detalhe. */
  const creditoFoto = (lot) =>
    lot.auctioneer_name
      ? `<div class="rodape-foto"><span class="cred-foto" title="Foto publicada por ${esc(lot.auctioneer_name)}">foto: ${esc(lot.auctioneer_name)}</span></div>`
      : '';

  const TITULO_DESCONTO =
    'Lance %d% abaixo da avaliação publicada pela fonte. Avaliação não é preço de venda, e lance de abertura não é preço de arremate.';

  function linhaMeta(lot) {
    const local = [...new Set([lot.city, lot.state].filter(Boolean))].join('/');
    return [
      lot.asset_type === 'imovel'
        // O tipo classificado vence a categoria crua: a Caixa manda 'apartamento'
        // minúsculo e o vlance manda 'imovel' para tudo.
        ? (LABEL_PROPERTY[lot.property_type] ?? lot.source_category ?? 'Imóvel')
        : lot.vehicle_type && lot.vehicle_type !== 'carro'
          ? LABEL_VEHICLE[lot.vehicle_type]
          : null,
      lot.year_model ? `${lot.year_make ?? ''}${lot.year_make ? '/' : ''}${lot.year_model}` : null,
      lot.km != null ? `${lot.km.toLocaleString('pt-BR')} km` : null,
      lot.area ? `${lot.area} m²` : null,
      lot.rooms ? `${lot.rooms} qto${lot.rooms > 1 ? 's' : ''}` : null,
      local || null,
    ].filter(Boolean);
  }

  /** O miolo do cartão. Quem chama decide o elemento (article clicável na busca, <a> na home). */
  function conteudo(lot) {
    const photo = (lot.photos && lot.photos[0]) || null;
    const bid = lot.current_bid ?? lot.min_bid;
    const when = whenLabel(lot);
    const temDesconto = lot.discount_pct != null && lot.discount_pct > 0 && !lot.bid_suspect;
    return `
    <div class="thumb">
      <img loading="lazy" class="${photo ? '' : 'is-nopic'}" src="${photo ? esc(img(photo, 640)) : nopicDe(lot)}"
           ${photo ? '' : 'data-fallback="yes"'}
           alt="${photo ? `Foto do lote ${esc(titulo(lot))}` : 'Lote sem foto disponível'}">
      <span class="src">${esc(SRC_LABEL[lot.source_id] ?? lot.source_id)}</span>
      ${lot.is_novo ? '<span class="novo">novo</span>' : ''}
      ${lot.doc_type ? `<span class="badge-doc">${esc(LABEL_DOC[lot.doc_type] ?? lot.doc_type)}</span>` : ''}
      <div class="rodape-foto">
        ${lot.auctioneer_name ? `<span class="cred-foto" title="Foto publicada por ${esc(lot.auctioneer_name)}">foto: ${esc(lot.auctioneer_name)}</span>` : ''}
        ${temDesconto ? `<span class="disc" title="${esc(TITULO_DESCONTO.replace('%d', lot.discount_pct))}">-${esc(lot.discount_pct)}%</span>` : ''}
      </div>
    </div>
    <div class="card-body">
      <div class="title">${esc(titulo(lot))}</div>
      <div class="meta">${linhaMeta(lot).map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      <div class="bid">
        ${bid != null
          ? `<span class="v">${money(bid)}</span><span class="lbl">${lot.current_bid != null ? 'lance atual' : 'lance mínimo'}</span>`
          : '<span class="lbl">sem lance publicado</span>'}
        ${lot.appraisal && !lot.bid_suspect && bid != null && lot.appraisal > bid ? `<span class="appraisal">${money(lot.appraisal)}</span>` : ''}
      </div>
      ${lot.bid_suspect ? '<div class="suspect" title="Valor publicado pela fonte fora de faixa plausível">valor atípico na fonte</div>' : ''}
      <div class="when ${when.cls}">${esc(when.text)}</div>
    </div>`;
  }

  return {
    esc, img, NOPIC, nopicDe, attachImgFallback, money,
    SRC_LABEL, LABEL_DOC, LABEL_VEHICLE, LABEL_PROPERTY,
    titulo, whenLabel, creditoFoto, conteudo,
  };
})();
