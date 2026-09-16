const $ = (id) => document.getElementById(id);
const state = { page: 1, lastItems: [], seq: 0, papel: 'comum', aba: 'busca', multi: {}, rotulos: {} };

// O cartão, os rótulos de fonte/documento e o formatador de moeda moram em
// cartao.js, para a busca e a home não divergirem de novo.
const {
  esc, img, nopicDe, attachImgFallback, money, titulo, whenLabel, creditoFoto,
  SRC_LABEL, LABEL_DOC, LABEL_VEHICLE, LABEL_PROPERTY,
} = Cartao;

const LABEL_STATUS = { aberto: 'Aberto para lances', agendado: 'Agendado', encerrado: 'Encerrado', vendido: 'Vendido', sem_data: 'Sem data definida' };
const LABEL_CLOSING = { timer_por_lote: 'Timer por lote', pregao_em_horario: 'Pregão em horário marcado', sequencial: 'Encerramento sequencial' };
const LABEL_ASSET = { veiculo: 'Veículo', imovel: 'Imóvel', outro: 'Outro (peça, lote misto)' };
const LABEL_CANAL = { sino: 'na plataforma', push: 'navegador', email: 'e-mail' };
const LABEL_COR = {
  branco: 'Branco', preto: 'Preto', prata: 'Prata', cinza: 'Cinza', vermelho: 'Vermelho',
  azul: 'Azul', verde: 'Verde', amarelo: 'Amarelo', marrom: 'Marrom', laranja: 'Laranja',
  roxo: 'Roxo', rosa: 'Rosa',
};
const LABEL_COMB = {
  flex: 'Flex', gasolina: 'Gasolina', alcool: 'Álcool', diesel: 'Diesel',
  gnv: 'GNV', eletrico: 'Elétrico', hibrido: 'Híbrido',
};
const LABEL_SELLER = { banco: 'Banco', seguradora: 'Seguradora', financeira: 'Financeira', locadora: 'Locadora', judicial: 'Judicial', orgao: 'Órgão público', particular: 'Particular', desconhecido: 'Não informado' };

function card(lot) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = lot.id;
  if (lot.auction_end_utc) el.dataset.fim = lot.auction_end_utc;
  const bid = lot.current_bid ?? lot.min_bid;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute(
    'aria-label',
    `${titulo(lot)}. ${bid != null ? money(bid) : 'sem lance publicado'}. ${whenLabel(lot).text}`,
  );
  el.innerHTML = Cartao.conteudo(lot);
  const open = () => openLot(lot.id);
  el.onclick = open;
  el.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  return el;
}

function filters() {
  const p = new URLSearchParams();
  const q = $('q').value.trim();
  if (q) p.set('q', q);
  for (const id of ['assetType', 'priceMin', 'priceMax', 'yearMin', 'yearMax', 'sort']) {
    const v = $(id).value;
    if (v) p.set(id, v);
  }
  // Os de seleção múltipla não são <select>: saem do componente como 'SP,RJ'.
  for (const id of Object.keys(MULTIS)) if (sel(id).size) p.set(id, [...sel(id)].join(','));
  if ($('onlyWithDate').checked) p.set('onlyWithDate', 'true');
  if ($('onlyWithPhoto').checked) p.set('onlyWithPhoto', 'true');
  p.set('page', String(state.page));
  return p;
}

function carregando(ligado) {
  document.querySelector('.searchbar').classList.toggle('carregando', ligado);
  $('barraCarga').classList.toggle('on', ligado);
  $('grid').classList.toggle('carregando', ligado);
}

async function search() {
  const grid = $('grid');
  const seq = ++state.seq;
  carregando(true);
  // Esqueleto só na primeira carga: trocar a grade inteira a cada filtro faz a
  // página pular. Com resultado na tela, o sinal é a barra e a opacidade.
  if (!state.lastItems.length) {
    grid.innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton"></div>').join('');
  }
  let data;
  try {
    const res = await fetch(`/api/search?${filters()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    // Sem isto a tela ficava em esqueleto para sempre, com o contador antigo
    // ainda no lugar, dando a impressão de que havia resultado.
    if (seq !== state.seq) return;
    carregando(false);
    $('total').textContent = '—';
    $('interpreted').innerHTML = '';
    grid.innerHTML =
      `<div class="empty">Não foi possível carregar os resultados (${esc(err.message)}).<br><button class="btn-clear" style="max-width:220px;margin:14px auto 0" id="retry">Tentar de novo</button></div>`;
    $('retry').onclick = search;
    return;
  }
  // Resposta atrasada de uma busca antiga não pode sobrescrever a atual.
  if (seq !== state.seq) return;
  carregando(false);
  state.lastItems = data.items;

  $('total').textContent = data.total.toLocaleString('pt-BR');
  const i = data.interpreted;
  const bits = [];
  if (i.brand) bits.push(`<span class="pill brand">marca: ${i.brand}</span>`);
  if (i.model) bits.push(`<span class="pill model">modelo: ${i.model}</span>`);
  for (const t of i.freeTerms) bits.push(`<span class="pill">texto: ${t}</span>`);
  $('interpreted').innerHTML = bits.length ? `interpretado como ${bits.join(' ')}` : '';

  grid.innerHTML = '';
  if (!data.items.length) {
    {
      // O contador ao lado já diz "lotes/veículos/imóveis"; a mensagem dizia
      // "veículo" mesmo com o filtro em imóvel.
      const t = $('assetType').value;
      const rotulo = t === 'imovel' ? 'imóvel' : t === 'veiculo' ? 'veículo' : 'lote';
      grid.innerHTML = `<div class="empty">Nenhum ${rotulo} encontrado com esses filtros.</div>`;
    }
  } else {
    for (const lot of data.items) grid.appendChild(card(lot));
    attachImgFallback(grid);
  }

  // Taxonomia FIXA, não descoberta: o usuário precisa ver "Imóvel (0)" enquanto
  // ainda não há imóvel no índice, senão a opção nem existe no select e escolhê-la
  // falha em silêncio.
  fillFixed('assetType', LABEL_ASSET, data.facets.assetTypes);
  for (const id of Object.keys(MULTIS)) pintaMulti(id, data.facets[MULTIS[id].faceta]);
  // Tipo de veículo só faz sentido quando o leilão é de veículo.
  // Filtros que só existem para veículo somem quando o usuário escolhe imóvel.
  const bem = $('assetType').value;
  const ehImovel = bem === 'imovel';
  // Cada filtro aparece quando é aplicável, não só quando é o lado escolhido:
  // sem filtro de bem a lista mistura os dois, e escolher "Apartamento" ali já
  // restringe a imóvel por si. Esconder um dos dois seria esconder metade.
  $('grpVehicleType').hidden = ehImovel;
  $('grpPropertyType').hidden = bem === 'veiculo';
  $('grpAno').style.display = ehImovel ? 'none' : '';
  // Cidade só faz sentido depois do estado: são 1.552 cidades no índice, e uma
  // lista desse tamanho não ajuda ninguém a achar Curitiba.
  $('grpCity').hidden = sel('uf').size === 0;
  // O rótulo só afirma o tipo quando o FILTRO garante o tipo. Sem filtro de
  // tipo de bem a lista mistura veículo e imóvel, e dizer "veículos" mente.
  $('totalLabel').textContent = ehImovel ? 'imóveis' : $('assetType').value === 'veiculo' ? 'veículos' : 'lotes';


  sincronizarUrl();

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  $('pageinfo').textContent = `página ${data.page} de ${pages}`;
  $('prev').disabled = data.page <= 1;
  $('next').disabled = data.page >= pages;
}

/**
 * Seleção múltipla nativa. Não usa select2 nem jQuery de propósito: o projeto
 * não tem dependência de frontend, e um <select multiple> nativo é ruim de usar
 * no celular (exige segurar Ctrl no desktop e vira lista rolante no toque).
 *
 * Tipo de leilão continua sendo escolha única, e isso não é esquecimento: a
 * tela troca de rótulo, de filtros e de contagem conforme o bem é veículo ou
 * imóvel, e "os dois ao mesmo tempo" é justamente o estado sem filtro.
 */
const MULTIS = {
  status: { vazio: 'Todas', plural: 'situações selecionadas', faceta: 'statuses', fixas: LABEL_STATUS },
  vehicleType: { vazio: 'Todos', plural: 'tipos selecionados', faceta: 'vehicleTypes', fixas: LABEL_VEHICLE },
  propertyType: { vazio: 'Todos', plural: 'tipos selecionados', faceta: 'propertyTypes', fixas: LABEL_PROPERTY },
  uf: { vazio: 'Todos', plural: 'estados selecionados', faceta: 'states' },
  // A chave é sem acento ('SAO PAULO'); o rótulo vem pronto do servidor, que
  // escolhe a melhor grafia entre as que as fontes publicam.
  city: { vazio: 'Todas', plural: 'cidades selecionadas', faceta: 'cities' },
  sellerType: { vazio: 'Todas', plural: 'origens selecionadas', faceta: 'sellerTypes', fixas: LABEL_SELLER },
  sourceId: { vazio: 'Todas', plural: 'fontes selecionadas', faceta: 'sources', rotulo: (v) => SRC_LABEL[v] ?? v },
  auctioneer: { vazio: 'Todos', plural: 'leiloeiros selecionados', faceta: 'auctioneers' },
};

const sel = (id) => (state.multi[id] ??= new Set());
const rotuloDe = (id, v) => state.rotulos[id]?.[v] ?? MULTIS[id].rotulo?.(v) ?? MULTIS[id].fixas?.[v] ?? v;

function resumoMulti(id) {
  const n = sel(id).size;
  if (n === 0) return MULTIS[id].vazio;
  if (n === 1) return rotuloDe(id, [...sel(id)][0]);
  return `${n} ${MULTIS[id].plural}`;
}

/** Compatibilidade com o resto do código, que fala em "tipos de veículo". */
const resumoTipos = () => resumoMulti('vehicleType');

function montaMulti(id) {
  const botao = $(`${id}Btn`);
  const lista = $(`${id}Lista`);
  const caixa = $(`${id}Box`);

  const fechar = () => {
    lista.hidden = true;
    botao.setAttribute('aria-expanded', 'false');
  };
  botao.onclick = () => {
    // Abrir uma fecha as outras: duas listas abertas se sobrepõem na lateral.
    for (const outro of Object.keys(MULTIS)) {
      if (outro !== id && $(`${outro}Lista`)) {
        $(`${outro}Lista`).hidden = true;
        $(`${outro}Btn`).setAttribute('aria-expanded', 'false');
      }
    }
    const abrir = lista.hidden;
    lista.hidden = !abrir;
    botao.setAttribute('aria-expanded', String(abrir));
  };
  document.addEventListener('click', (e) => {
    if (!caixa.contains(e.target)) fechar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lista.hidden) {
      fechar();
      botao.focus();
    }
  });
}

function pintaMulti(id, rows = []) {
  const cfg = MULTIS[id];
  const lista = $(`${id}Lista`);
  if (!lista) return;
  const escolhidos = sel(id);
  const counts = Object.fromEntries(rows.map((r) => [String(r.value), r.count]));
  // Faceta que manda rótulo próprio (cidade) sobrepõe o dicionário local.
  for (const r of rows) if (r.label) (state.rotulos[id] ??= {})[String(r.value)] = r.label;

  // Taxonomia fixa mostra opção com zero (o usuário precisa ver que existe e
  // está vazia); faceta livre — UF, fonte, leiloeiro — só mostra o que existe,
  // mais o que já está marcado, senão o filtro ativo some da lista e não há
  // como desfazer.
  const valores = cfg.fixas
    ? Object.keys(cfg.fixas)
    : [...new Set([...rows.map((r) => String(r.value)), ...escolhidos])];

  const opcoes = valores
    .map((v) => ({ v, l: rotuloDe(id, v), n: counts[v] ?? 0 }))
    .filter((o) => cfg.fixas || o.n > 0 || escolhidos.has(o.v))
    .sort((a, b) => b.n - a.n || a.l.localeCompare(b.l, 'pt-BR'));

  lista.innerHTML =
    (opcoes.length
      ? opcoes
          .map(
            (o) => `<label><input type="checkbox" value="${esc(o.v)}"${escolhidos.has(o.v) ? ' checked' : ''}>
              <span>${esc(o.l)}</span><span class="conta">${o.n.toLocaleString('pt-BR')}</span></label>`,
          )
          .join('')
      : '<p class="multi-vazio">Nenhuma opção para os filtros atuais.</p>') +
    `<div class="multi-acoes"><button type="button" data-limpar="${id}">Limpar seleção</button></div>`;

  const aplicar = () => {
    // Mexer no estado invalida a cidade escolhida: "Curitiba" com PR desmarcado
    // vira filtro invisível que zera o resultado sem dizer por quê.
    if (id === 'uf') {
      sel('city').clear();
      $('cityResumo').textContent = resumoMulti('city');
    }
    $(`${id}Resumo`).textContent = resumoMulti(id);
    state.page = 1;
    atualizaContadorFiltros();
    search();
  };
  for (const cb of lista.querySelectorAll('input')) {
    cb.onchange = () => {
      cb.checked ? escolhidos.add(cb.value) : escolhidos.delete(cb.value);
      aplicar();
    };
  }
  lista.querySelector('[data-limpar]').onclick = () => {
    escolhidos.clear();
    aplicar();
  };
  $(`${id}Resumo`).textContent = resumoMulti(id);
}

function fillFixed(id, labels, rows) {
  const sel = $(id);
  const current = sel.value;
  const counts = Object.fromEntries(rows.map((r) => [r.value, r.count]));
  const first = sel.querySelector('option').outerHTML;
  const opts = Object.entries(labels)
    .map(([v, l]) => ({ v, l, n: counts[v] ?? 0 }))
    .filter((o) => o.n > 0 || o.v === current || o.v === 'veiculo' || o.v === 'imovel')
    .sort((a, b) => b.n - a.n || a.l.localeCompare(b.l));
  sel.innerHTML = first + opts.map((o) => `<option value="${esc(o.v)}">${esc(o.l)} (${o.n})</option>`).join('');
  sel.value = current;
}


/** O jargão do modelo de encerramento só diz algo para quem construiu o índice. */
const EXPLICA_FECHAMENTO = {
  timer_por_lote: 'Cada lote fecha na própria hora, com cronômetro.',
  pregao_em_horario: 'Pregão em horário marcado. A fonte não publica hora de fim por lote.',
  sequencial: 'Encerramento sequencial: os lotes fecham um após o outro, sem hora fixa por lote.',
};

const dataBr = (v) => (v ? new Date(v).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);

/**
 * Linha vazia não vira "—": ou o campo some, ou diz por que está vazio.
 * Travessão solto não distingue "a fonte não publica" de "a coleta falhou",
 * e era o que enchia metade do painel.
 */
const linhasKv = (pares) =>
  pares
    .filter(([, v]) => v != null && v !== '')
    // Endereço e explicação de encerramento passam de 40 caracteres e não cabem
    // numa coluna de quarto de largura: ocupam a linha inteira.
    .map(([k, v]) => `<div class="par${String(v).length > 40 ? ' largo' : ''}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');

const blocoKv = (titulo, pares) => {
  const corpo = linhasKv(pares);
  return corpo ? `<section class="grp"><h3>${esc(titulo)}</h3><dl class="kv">${corpo}</dl></section>` : '';
};

async function openLot(id, empilhar = true) {
  const res = await fetch(`/api/lot/${id}`);
  if (!res.ok) {
    toast('Lote não encontrado.');
    if (!empilhar) history.replaceState({ aba: state.aba }, '', `/${state.aba}`);
    return;
  }
  const lot = await res.json();
  // A URL do lote é compartilhável: quem recebe o link abre o drawer direto.
  if (empilhar) history.pushState({ aba: state.aba, lote: lot.id }, '', `/lote/${slugDoLote(lot)}`);
  const when = whenLabel(lot);

  const lance = lot.current_bid ?? lot.min_bid;
  const rotuloLance = lot.current_bid != null ? 'Lance atual' : 'Lance mínimo';
  const desconto =
    !lot.bid_suspect && lot.appraisal && lance != null && lot.appraisal > lance
      ? Math.round((1 - lance / lot.appraisal) * 100)
      : null;

  const chips = [
    lot.current_bid != null && lot.min_bid != null ? ['Mínimo', money(lot.min_bid)] : null,
    lot.bid_increment != null ? ['Incremento', money(lot.bid_increment)] : null,
    lot.fees_pct ? ['Comissão', `${lot.fees_pct}%`] : null,
  ].filter(Boolean);

  const local = [...new Set([lot.yard, [lot.city, lot.state].filter(Boolean).join(' - ')].filter(Boolean))].join(' · ');
  const safeUrl = /^https?:\/\//.test(lot.lot_url ?? '') ? lot.lot_url : null;

  $('panel').innerHTML = `
    <header class="panel-top">
      <div>
        <h2 id="drawerTitle" title="${esc(lot.title_raw)}">${esc(titulo(lot))}</h2>
        <div class="panel-sub">
          <span class="pill ${when.cls}">${esc(when.text)}</span>
          <span class="pill quieto">${esc(LABEL_STATUS[lot.status] ?? lot.status)}</span>
          <span class="pill quieto">${esc(SRC_LABEL[lot.source_id] ?? lot.source_id)}</span>
          ${lot.doc_type ? `<span class="pill quieto">${esc(LABEL_DOC[lot.doc_type] ?? lot.doc_type)}</span>` : ''}
        </div>
      </div>
      <button class="close" id="closeBtn" aria-label="Fechar detalhe do lote">×</button>
    </header>

    <div class="panel-corpo">
    <div class="col-midia">
    ${lot.photos?.length
      ? `<figure class="hero"><img id="heroImg" src="${esc(img(lot.photos[0], 1200))}" alt="Foto principal de ${esc(titulo(lot))}">${creditoFoto(lot)}</figure>
         ${lot.photos.length > 1
           ? `<div class="gallery">${lot.photos.slice(0, 18).map((p, i) => `<img loading="lazy" class="thumb-pick${i === 0 ? ' on' : ''}" src="${esc(img(p, 180))}" data-big="${esc(img(p, 1200))}" alt="Foto ${i + 1} de ${esc(titulo(lot))}">`).join('')}</div>`
           : ''}`
      : `<figure class="hero"><img id="heroImg" class="is-nopic" data-fallback="yes" src="${nopicDe(lot)}" alt="Lote sem foto disponível"></figure>`}

    </div>

    <div class="col-dados">
    <div class="preco">
      <div class="preco-lbl">${esc(rotuloLance)}</div>
      <div class="preco-v${lance == null ? ' vazio' : ''}">${lance != null ? money(lance) : 'a fonte não publica valor para este lote'}</div>
      ${desconto != null ? `<div class="preco-desc"><b>${desconto}% abaixo</b> da avaliação de ${money(lot.appraisal)} <span class="nota">— avaliação não é preço de venda</span></div>` : ''}
      ${lot.bid_suspect ? '<div class="preco-alerta">A fonte publicou um valor fora de faixa plausível. Confira no site do leiloeiro antes de decidir.</div>' : ''}
      ${chips.length ? `<div class="preco-chips">${chips.map(([k, v]) => `<span><i>${esc(k)}</i>${esc(v)}</span>`).join('')}</div>` : ''}
    </div>

    ${safeUrl ? `<a class="open-src" href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer">Abrir no site do leiloeiro →</a>` : '<p class="sem-link">A fonte não publica link direto para este lote.</p>'}

    ${blocoKv('Quando e onde', [
      ['Início do leilão', dataBr(lot.auction_start_utc)],
      ['Encerramento', dataBr(lot.auction_end_utc) ?? (EXPLICA_FECHAMENTO[lot.closing_model] ?? 'não publicado por lote')],
      ['Localização', local],
    ])}

    ${blocoKv('O bem', [
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
      ['Cor', lot.color ? (LABEL_COR[lot.color] ?? lot.color) : null],
      ['Combustível', lot.fuel ? (LABEL_COMB[lot.fuel] ?? lot.fuel) : null],
      ['Placa', lot.plate_masked],
    ])}

    ${blocoKv('Quem vende', [
      ['Leiloeiro', [lot.auctioneer_name, lot.auctioneer_reg].filter(Boolean).join(' — ') || null],
      ['Comitente', lot.seller_name],
      ['Tipo de comitente', lot.seller_type ? (LABEL_SELLER[lot.seller_type] ?? lot.seller_type) : null],
    ])}

    ${lot.bid_history?.length
      ? `<section class="grp"><h3>Histórico de lance observado</h3>
          <div class="hist">${lot.bid_history.map((h) => `<div><span>${money(h.bid)}</span><span style="color:var(--fg-3)">${dataBr(h.observed_at)}</span></div>`).join('')}</div>
         </section>`
      : ''}

    <details class="proc">
      <summary>Procedência do dado</summary>
      <dl class="kv">${linhasKv([
        ['Fonte', SRC_LABEL[lot.source_id] ?? lot.source_id],
        ['Classificação na fonte', lot.source_category ?? 'a fonte não classifica'],
        ['Título publicado pela fonte', lot.title_display && lot.title_display !== lot.title_raw ? lot.title_raw : null],
        ['Modelo de encerramento', EXPLICA_FECHAMENTO[lot.closing_model] ?? lot.closing_model],
        ['Fuso publicado pela fonte', lot.source_tz],
        ['Entrou na base em', dataBr(lot.first_seen_at)],
        ['Coletado em', dataBr(lot.collected_at)],
      ])}</dl>
    </details>
    </div>
    </div>`;
  // Miniatura troca a foto principal: a galeria antiga mostrava 12 quadradinhos
  // de 90px e desperdiçava a resolução que a origem entrega.
  const hero = $('heroImg');
  for (const t of $('panel').querySelectorAll('.thumb-pick')) {
    t.addEventListener('click', () => {
      $('panel').querySelectorAll('.thumb-pick').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      if (hero) hero.src = t.dataset.big;
    });
  }
  attachImgFallback($('panel'));
  state.lastFocus = document.activeElement;
  $('drawer').classList.add('open');
  $('closeBtn').onclick = () => closeDrawer();
  $('closeBtn').focus();
}
// O foco volta para o card de origem: sem isso, quem navega por teclado
// era devolvido ao topo da página a cada lote aberto.
const closeDrawer = (voltarHistorico = true) => {
  const estavaAberto = $('drawer').classList.contains('open');
  $('drawer').classList.remove('open');
  if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus();
  // Fechar pelo X ou Esc tem que desfazer o pushState do lote, senão o botão
  // "voltar" do navegador reabriria o drawer que o usuário acabou de fechar.
  if (estavaAberto && voltarHistorico && location.pathname.startsWith('/lote/')) history.back();
};
document.querySelector('.scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

async function loadCoverage() {
  const data = await (await fetch('/api/stats')).json();
  const t = data.totals;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  $('stats').innerHTML = [
    ['Lotes no índice', t.lots.toLocaleString('pt-BR')],
    ['Abertos para lance', t.abertos.toLocaleString('pt-BR')],
    ['Agendados', t.agendados.toLocaleString('pt-BR')],
    ['Sem data definida', `${t.sem_data.toLocaleString('pt-BR')} (${pct(t.sem_data, t.lots)}%)`],
    ['Com encerramento por lote', `${t.com_fim.toLocaleString('pt-BR')} (${pct(t.com_fim, t.lots)}%)`],
    ['Com lance publicado', `${t.com_lance.toLocaleString('pt-BR')} (${pct(t.com_lance, t.lots)}%)`],
    ['Com quilometragem', `${t.com_km.toLocaleString('pt-BR')} (${pct(t.com_km, t.lots)}%)`],
    ['Marcas reconhecidas', t.marcas],
    ['Veículos', t.veiculos.toLocaleString('pt-BR')],
    ['Imóveis', t.imoveis.toLocaleString('pt-BR')],
    ['Fora do escopo (peça, lote misto)', t.outros.toLocaleString('pt-BR')],
  ].map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');

  $('bysource').innerHTML =
    '<tr><th>Fonte</th><th>Lotes</th><th>Com fim por lote</th><th>Com lance</th><th>Com km</th><th>Última coleta</th></tr>' +
    data.bySource
      .map(
        (s) =>
          `<tr><td>${esc(s.name)}</td><td>${s.lots}</td><td>${s.com_fim} (${pct(s.com_fim, s.lots)}%)</td><td>${s.com_lance} (${pct(s.com_lance, s.lots)}%)</td><td>${s.com_km} (${pct(s.com_km, s.lots)}%)</td><td>${s.ultima_coleta ? new Date(s.ultima_coleta).toLocaleString('pt-BR') : '—'}</td></tr>`,
      )
      .join('');

  const LOTES = [['lotes lidos na fonte', 'lidos'], ['lotes gravados no índice', 'gravados'], ['lotes descartados', 'descartados']];
  const COLUNAS = {
    collect: LOTES,
    'collect:cli': LOTES,
    discover: [['sites sondados', 'sondados'], ['com plataforma identificada', 'com plataforma'], ['fora do ar', 'fora do ar']],
  };
  $('runs').innerHTML =
    '<tr><th>Fonte</th><th>Rotina</th><th>Início</th><th>Resultado</th><th colspan="3">Contagem <span class="th-nota">(passe o mouse)</span></th></tr>' +
    data.runs
      .map((r) => {
        const cols = COLUNAS[r.job] ?? LOTES;
        const num = (v, i) => `<td title="${esc(cols[i][0])}">${v}<span class="col-nota">${esc(cols[i][1])}</span></td>`;
        return `<tr><td>${esc(r.source_id)}</td><td>${esc(r.job === 'discover' ? 'descoberta' : r.job)}</td>
           <td>${new Date(r.started_at).toLocaleString('pt-BR')}</td>
           <td class="${r.ok ? 'tag-ok' : 'tag-bad'}" title="${esc(r.error ?? '')}">${r.ok === null ? 'em curso' : r.ok ? 'ok' : 'falhou' + (r.http_status ? ` (HTTP ${r.http_status})` : '')}</td>
           ${num(r.fetched, 0)}${num(r.upserted, 1)}${num(r.skipped, 2)}</tr>`;
      })
      .join('');
}

// WebSocket: o worker publica mudança de lance e a lista pisca sem recarregar.
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('wsdot').classList.add('on');
    // Heartbeat: socket meio-aberto (rede caiu sem FIN) mantinha o indicador
    // verde indefinidamente. Sem tráfego em 90s, tratamos como caído.
    clearInterval(state.hb);
    state.lastMsg = Date.now();
    state.hb = setInterval(() => {
      if (Date.now() - state.lastMsg > 90000) {
        $('wsdot').classList.remove('on');
        try { ws.close(); } catch {}
      }
    }, 15000);
  };
  ws.onclose = () => {
    clearInterval(state.hb);
    $('wsdot').classList.remove('on');
    setTimeout(connectWs, 4000);
  };
  ws.onmessage = (ev) => {
    state.lastMsg = Date.now();
    const msg = JSON.parse(ev.data);
    if (msg.type === 'bids') {
      for (const c of msg.changes) {
        const el = document.querySelector(`.card[data-id="${c.lotId}"]`);
        if (el) {
          el.classList.remove('flash');
          void el.offsetWidth;
          el.classList.add('flash');
          const v = el.querySelector('.bid .v');
          if (v) v.textContent = money(c.newBid);
        }
        toast(`Novo lance: ${c.title.slice(0, 40)} → ${money(c.newBid)}`);
      }
    }
    // O servidor já não envia 'collect' para quem não é admin; esta guarda é o
    // segundo cinto, para o caso de a mensagem chegar por outro caminho.
    if (msg.type === 'collect' && state.papel === 'admin') {
      toast(`Coleta ${msg.sourceId}: ${msg.upserted} lotes atualizados`);
    }
    if (msg.type === 'encerrados' && state.papel === 'admin') {
      const n = Number(msg.total) || 0;
      toast(`${n.toLocaleString('pt-BR')} lote${n === 1 ? '' : 's'} encerrado${n === 1 ? '' : 's'}`);
      // O lote que fechou continua desenhado na tela até a próxima busca: marcar
      // o cartão é mais honesto do que deixar "Encerra em 3 min" congelado.
      for (const el of document.querySelectorAll('.card .when')) {
        if (/encerra em/i.test(el.textContent)) {
          const fim = el.closest('.card')?.dataset.fim;
          if (fim && new Date(fim).getTime() < Date.now()) {
            el.textContent = 'Encerrado';
            el.className = 'when nodate';
          }
        }
      }
    }
    if (msg.type === 'alertas') {
      const b = $('sinoBadge');
      b.textContent = Number(b.textContent || 0) + msg.disparos.length;
      b.hidden = false;
      for (const d of msg.disparos.slice(0, 3)) toast(`Alerta "${d.label}": ${d.title.slice(0, 40)}`);
      if ($('view-alertas').style.display !== 'none') carregarAlertas();
    }
  };
}
const TOASTS_VISIVEIS = 3;
function toast(text) {
  const caixa = $('toast');
  const el = document.createElement('div');
  el.textContent = text; // textContent já neutraliza HTML
  caixa.appendChild(el);
  // Uma coleta grande dispara um aviso por lance e empilhava 20+ caixas, que
  // cobriam a tela inteira e o drawer aberto. O que chega novo empurra o
  // mais antigo para fora em vez de somar.
  while (caixa.children.length > TOASTS_VISIVEIS) caixa.firstElementChild.remove();
  setTimeout(() => el.remove(), 6000);
}

$('form').onsubmit = (e) => {
  e.preventDefault();
  // Buscar de dentro de Cobertura ou Alertas tem de trazer o usuário para o
  // resultado; antes a busca rodava numa aba que ele não estava vendo.
  abrirAba('busca');
  // No celular o teclado só fecha quando o campo perde o foco. Vale tanto para
  // o Enter do teclado quanto para o toque em Buscar, porque os dois caem aqui.
  $('q').blur();
  state.page = 1;
  search();
};
for (const id of ['assetType', 'sort']) {
  $(id).onchange = () => {
    // Trocar para imóvel zera o tipo de veículo, senão o filtro invisível
    // continuaria valendo e o resultado viria vazio sem explicação.
    if (id === 'assetType') {
      // Filtro escondido que continua valendo devolve resultado vazio sem
      // explicação: ao trocar de bem, a seleção do outro lado é zerada.
      const oposto = $('assetType').value === 'imovel' ? 'vehicleType' : 'propertyType';
      sel(oposto).clear();
      $(`${oposto}Resumo`).textContent = resumoMulti(oposto);
    }
    if (id === 'assetType' && $('assetType').value === 'imovel') {
      $('yearMin').value = '';
      $('yearMax').value = '';
    }
    state.page = 1;
    atualizaContadorFiltros();
    search();
  };
}
for (const id of ['priceMin', 'priceMax', 'yearMin', 'yearMax']) {
  $(id).onchange = () => { state.page = 1; atualizaContadorFiltros(); search(); };
}
for (const id of ['onlyWithDate', 'onlyWithPhoto']) {
  $(id).onchange = () => { state.page = 1; atualizaContadorFiltros(); search(); };
}
$('clear').onclick = () => {
  for (const id of ['q', 'assetType', 'priceMin', 'priceMax', 'yearMin', 'yearMax']) $(id).value = '';
  for (const id of Object.keys(MULTIS)) {
    sel(id).clear();
    $(`${id}Resumo`).textContent = resumoMulti(id);
  }
  $('onlyWithDate').checked = false;
  $('onlyWithPhoto').checked = false;
  state.page = 1;
  atualizaContadorFiltros();
  search();
};
$('prev').onclick = () => { state.page--; search(); window.scrollTo(0, 0); };
$('next').onclick = () => { state.page++; search(); window.scrollTo(0, 0); };
function abrirAba(v, empilhar = true) {
  const b = document.querySelector(`nav.tabs button[data-view="${v}"]`);
  if (!b) return;
  state.aba = v;
  const alvo = v === 'busca' ? rotaDaBusca() : `/${v}`;
  if (empilhar && location.pathname + location.search !== alvo) history.pushState({ aba: v }, '', alvo);
  document.querySelectorAll('nav.tabs button').forEach((x) => {
    x.classList.remove('on');
    x.setAttribute('aria-selected', 'false');
  });
  b.classList.add('on');
  b.setAttribute('aria-selected', 'true');
  {
    $('view-busca').style.display = v === 'busca' ? '' : 'none';
    $('view-cobertura').style.display = v === 'cobertura' ? '' : 'none';
    $('view-alertas').style.display = v === 'alertas' ? '' : 'none';
    if (v === 'cobertura') loadCoverage();
    if (v === 'alertas') {
      carregarAlertas();
      fetch('/api/alerts/hits/seen', { method: 'POST' }).then(() => {
        $('sinoBadge').hidden = true;
      });
    }
  }
}

document.querySelectorAll('nav.tabs button').forEach((b) => {
  b.onclick = () => abrirAba(b.dataset.view);
});

/** Campos de valor único; os de seleção múltipla vivem em MULTIS. */
const CAMPOS_FILTRO = ['assetType', 'priceMin', 'priceMax', 'yearMin', 'yearMax'];

function atualizaContadorFiltros() {
  const n =
    CAMPOS_FILTRO.filter((id) => $(id).value).length +
    Object.keys(MULTIS).reduce((t, id) => t + sel(id).size, 0) +
    ($('onlyWithDate').checked ? 1 : 0) +
    ($('onlyWithPhoto').checked ? 1 : 0);
  const alvo = $('filtrosAtivos');
  alvo.textContent = n;
  alvo.hidden = n === 0;
}

function montaPainelFiltros() {
  const botao = $('filtrosToggle');
  const painel = $('filtros');
  const celular = () => window.matchMedia('(max-width: 980px)').matches;
  const aplica = () => {
    if (celular()) {
      const aberto = botao.getAttribute('aria-expanded') === 'true';
      painel.hidden = !aberto;
    } else {
      painel.hidden = false; // no desktop a lateral é sempre visível
    }
  };
  botao.onclick = () => {
    botao.setAttribute('aria-expanded', botao.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    aplica();
  };
  window.addEventListener('resize', aplica);
  aplica();
}

/* ---------------- alertas ---------------- */

function filtrosAtuais() {
  const f = {};
  for (const id of CAMPOS_FILTRO) if ($(id).value) f[id] = $(id).value;
  for (const id of Object.keys(MULTIS)) if (sel(id).size) f[id] = [...sel(id)].join(',');
  if ($('onlyWithPhoto').checked) f.onlyWithPhoto = true;
  return f;
}

async function pushInscrito() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(await reg?.pushManager.getSubscription());
}

/** base64url -> Uint8Array, formato que o PushManager exige na chave VAPID. */
function chaveParaBytes(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function ativarPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Este navegador não suporta notificação push.');
    return false;
  }
  // Push exige origem segura. Em HTTP na rede local o navegador recusa em silêncio.
  if (!window.isSecureContext) {
    toast('Push só funciona em HTTPS. Use o endereço https desta máquina.');
    return false;
  }
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') {
    toast('Permissão de notificação negada.');
    return false;
  }
  const { publicKey } = await (await fetch('/api/push/key')).json();
  if (!publicKey) {
    toast('Servidor sem chave VAPID configurada.');
    return false;
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(publicKey) }));
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  toast('Notificações ativadas neste aparelho.');
  return true;
}

/** null = criando; id = editando o alerta existente. */
let alertaEmEdicao = null;

function abrirDialogo({ id = null, label = '', q = '', canais = ['sino'], email = '', resumo = '' }) {
  alertaEmEdicao = id;
  $('alertaLabel').value = label;
  $('canalPush').checked = canais.includes('push');
  $('canalEmail').checked = canais.includes('email');
  $('alertaEmail').value = email ?? '';
  $('alertaEmail').hidden = !canais.includes('email');
  $('dlgResumo').textContent = resumo;
  $('dlgTitulo').textContent = id ? 'Editar alerta' : 'Criar alerta';
  $('btnSalvarAlerta').textContent = id ? 'Salvar' : 'Criar alerta';
  $('dlgAlerta').showModal();
}

function montaDialogoAlerta() {
  const dlg = $('dlgAlerta');
  $('canalEmail').onchange = () => {
    $('alertaEmail').hidden = !$('canalEmail').checked;
  };
  $('criarAlerta').onclick = () => {
    const q = $('q').value.trim();
    const f = filtrosAtuais();
    if (!q && !Object.keys(f).length) {
      toast('Faça uma busca ou escolha um filtro antes de criar o alerta.');
      return;
    }
    abrirDialogo({
      label: q || 'Meus filtros',
      q,
      resumo: [q ? `busca "${q}"` : null, Object.keys(f).length ? `${Object.keys(f).length} filtro(s)` : null]
        .filter(Boolean)
        .join(' · '),
    });
  };

  $('formAlerta').onsubmit = async (e) => {
    // `e.submitter` é undefined em alguns navegadores; sem o fallback o form
    // fecha pelo method="dialog" e nenhum alerta é criado, em silêncio.
    const acao = e.submitter?.value ?? 'ok';
    if (acao !== 'ok') return;
    e.preventDefault();

    const botao = $('btnSalvarAlerta');
    const rotulo = botao.textContent;
    botao.disabled = true;
    botao.textContent = 'Criando…';

    try {
      const canais = ['sino'];
      if ($('canalPush').checked) {
        // Push é opcional: se o navegador recusar, o alerta ainda é criado com
        // os outros canais em vez de a criação inteira falhar.
        try {
          if ((await pushInscrito()) || (await ativarPush())) canais.push('push');
        } catch (err) {
          toast(`Push indisponível: ${err?.message ?? 'erro'}. Alerta criado sem ele.`);
        }
      }
      if ($('canalEmail').checked) {
        const email = $('alertaEmail').value.trim();
        if (!email) {
          toast('Informe o e-mail ou desmarque o canal de e-mail.');
          return;
        }
        canais.push('email');
      }

      const editando = alertaEmEdicao !== null;
      const corpo = editando
        ? {
            label: $('alertaLabel').value.trim(),
            channels: canais,
            email: $('canalEmail').checked ? $('alertaEmail').value.trim() : null,
          }
        : {
            label: $('alertaLabel').value.trim() || $('q').value.trim() || 'Alerta',
            q: $('q').value.trim(),
            filters: filtrosAtuais(),
            channels: canais,
            email: $('canalEmail').checked ? $('alertaEmail').value.trim() : null,
          };

      const res = await fetch(editando ? `/api/alerts/${alertaEmEdicao}` : '/api/alerts', {
        method: editando ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(`Não foi possível salvar: ${r.erro ?? `erro ${res.status}`}`);
        return;
      }

      $('dlgAlerta').close();
      toast(
        alertaEmEdicao !== null
          ? `Alerta "${corpo.label}" atualizado.`
          : `Alerta "${corpo.label}" criado${r.casados_agora ? ` — ${r.casados_agora} lote(s) já encontrados` : ''}.`,
      );
      carregarAlertas();
    } catch (err) {
      // Sem este catch, qualquer exceção deixava o diálogo aberto e mudo.
      toast(`Falha ao criar alerta: ${err?.message ?? err}`);
    } finally {
      botao.disabled = false;
      botao.textContent = rotulo;
    }
  };
}

async function carregarAlertas() {
  let alertas, hits;
  try {
    const [ra, rh] = await Promise.all([fetch('/api/alerts'), fetch('/api/alerts/hits')]);
    if (!ra.ok || !rh.ok) throw new Error(`erro ${ra.status}/${rh.status}`);
    [alertas, hits] = [await ra.json(), await rh.json()];
  } catch (err) {
    $('listaAlertas').innerHTML = `<div class="empty">Não foi possível carregar os alertas (${esc(err?.message ?? err)}).</div>`;
    return;
  }

  const naoVistos = hits.filter((h) => !h.seen).length;
  const badge = $('sinoBadge');
  badge.textContent = naoVistos;
  badge.hidden = naoVistos === 0;

  $('listaAlertas').innerHTML = alertas.length
    ? alertas
        .map(
          (a) => `<div class="alerta-item">
            <div class="alerta-txt">
              <b>${esc(a.label)}</b>
              <span class="alerta-canais">${a.channels.map((c) => esc(LABEL_CANAL[c] ?? c)).join(' · ')}</span>
            </div>
            <span class="alerta-lotes">${a.total} lote${a.total === 1 ? '' : 's'}</span>
            <button class="ico" data-edit="${a.id}" title="Editar alerta" aria-label="Editar ${esc(a.label)}">✏️</button>
            <button class="ico" data-del="${a.id}" title="Remover alerta" aria-label="Remover ${esc(a.label)}">🗑️</button>
          </div>`,
        )
        .join('')
    : '<div class="empty">Nenhum alerta ainda. Faça uma busca e clique em "Criar alerta".</div>';

  for (const b of $('listaAlertas').querySelectorAll('[data-edit]')) {
    b.onclick = () => {
      const a = alertas.find((x) => String(x.id) === b.dataset.edit);
      if (!a) return;
      abrirDialogo({
        id: a.id,
        label: a.label,
        canais: a.channels,
        email: a.email ?? '',
        resumo: a.q ? `busca "${a.q}"` : 'somente filtros',
      });
    };
  }

  for (const b of $('listaAlertas').querySelectorAll('[data-del]')) {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '…';
      try {
        const res = await fetch(`/api/alerts/${b.dataset.del}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`erro ${res.status}`);
        toast('Alerta removido.');
        carregarAlertas();
      } catch (err) {
        toast(`Não foi possível remover: ${err?.message ?? err}`);
        b.disabled = false;
        b.textContent = '🗑️';
      }
    };
  }

  // Mesmo card da listagem, não uma segunda lista: o lote encontrado precisa
  // mostrar foto, lance, desconto e prazo com as mesmas regras da busca, e
  // manter dois renderizadores era garantia de divergirem.
  const caixa = $('listaHits');
  caixa.innerHTML = '';
  if (!hits.length) {
    caixa.className = '';
    caixa.innerHTML =
      '<div class="empty">Nada encontrado ainda. O alerta dispara quando um lote novo casar com a sua busca.</div>';
  } else {
    caixa.className = 'grid';
    for (const h of hits) {
      const el = card(h);
      if (!h.seen) el.classList.add('hit-novo');
      const rodape = document.createElement('div');
      rodape.className = 'hit-alerta';
      rodape.innerHTML = `<span class="hit-termo">${h.labels.map((l) => esc(l)).join(', ')}</span>` +
        `<span class="hit-quando">${new Date(h.hit_em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>`;
      el.querySelector('.card-body').appendChild(rodape);
      caixa.appendChild(el);
    }
    attachImgFallback(caixa);
  }

  const podePush = 'PushManager' in window && window.isSecureContext;
  $('permissaoPush').innerHTML =
    podePush && Notification.permission !== 'granted'
      ? '<div class="aviso">Ative a notificação do navegador para receber alerta mesmo com a aba fechada.<button id="btnPush">Ativar</button></div>'
      : !window.isSecureContext
        ? '<div class="aviso">Notificação do navegador exige HTTPS. Abra pelo endereço https desta máquina para ativar.</div>'
        : '';
  // No celular, o certificado próprio não basta: o Chrome só registra service
  // worker sobre certificado CONFIÁVEL. Daí o link para instalar a CA.
  if (location.protocol === 'https:' && Notification.permission !== 'granted') {
    $('permissaoPush').innerHTML +=
      '<div class="aviso">No celular, antes de ativar: baixe e instale a autoridade local em Ajustes → Segurança → Instalar certificado → Certificado CA. ' +
      '<a href="/ca.crt" download style="color:var(--accent)">Baixar certificado</a></div>';
  }
  if ($('btnPush')) $('btnPush').onclick = ativarPush;
}

/**
 * O papel vem do servidor, decodificado do cookie assinado. Esconder a aba é
 * cortesia visual: quem barra de fato é o 403 das rotas de administrador.
 */
async function aplicarPapel() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) return;
    const { papel } = await r.json();
    state.papel = papel ?? 'comum';
  } catch {
    /* sem resposta, segue como comum */
  }
  if (state.papel !== 'admin') {
    document.querySelector('nav.tabs button[data-view="cobertura"]')?.remove();
  }
}

/**
 * Roteador. O app continua sendo uma página só: o caminho decide a aba e o
 * lote aberto, e o botão "voltar" do navegador passa a funcionar dentro dele.
 */
function viewDoCaminho() {
  const p = location.pathname;
  if (p === '/alertas') return 'alertas';
  if (p === '/cobertura') return 'cobertura';
  return 'busca';
}

function rotear(empilhar = false) {
  const lote = location.pathname.startsWith('/lote/') ? idDoSlug(location.pathname.slice(6)) : null;
  // Sob /lote/ a aba de fundo é a última visitada, não uma aba nova.
  const alvo = lote ? state.aba : viewDoCaminho();
  // Papel comum não tem a aba Cobertura: cair nela deixaria a tela vazia.
  const aba = document.querySelector(`nav.tabs button[data-view="${alvo}"]`) ? alvo : 'busca';
  abrirAba(aba, empilhar);
  if (lote) openLot(lote, false);
  else closeDrawer(false);
}

/**
 * A tela inteira cabe na URL: quem manda o link manda a busca junto.
 * Página 1 e valores vazios ficam de fora para o link não virar um paredão.
 */
function estadoDaTela() {
  const p = new URLSearchParams();
  if ($('q').value.trim()) p.set('q', $('q').value.trim());
  for (const id of CAMPOS_FILTRO) if ($(id).value) p.set(id, $(id).value);
  for (const id of Object.keys(MULTIS)) if (sel(id).size) p.set(id, [...sel(id)].join(','));
  if ($('onlyWithDate').checked) p.set('onlyWithDate', '1');
  if ($('onlyWithPhoto').checked) p.set('onlyWithPhoto', '1');
  if ($('sort').value && $('sort').value !== 'ending_soon') p.set('sort', $('sort').value);
  if (state.page > 1) p.set('page', String(state.page));
  return p;
}

const rotaDaBusca = () => {
  const qs = estadoDaTela().toString();
  return `/busca${qs ? `?${qs}` : ''}`;
};

/**
 * replaceState e não pushState: cada tecla digitada e cada troca de filtro
 * empilharia uma entrada, e o "voltar" do navegador viraria um desfazer
 * caractere a caractere. Quem empilha é a troca de aba e a abertura do lote.
 */
function sincronizarUrl() {
  if (state.aba !== 'busca' || location.pathname.startsWith('/lote/')) return;
  const alvo = rotaDaBusca();
  if (location.pathname + location.search !== alvo) history.replaceState(history.state, '', alvo);
}

/**
 * Caminho inverso: a URL pinta a tela. Vale tanto para o link que chegou de
 * fora quanto para o "voltar" do navegador.
 */
function aplicarParametrosDaUrl() {
  const p = new URLSearchParams(location.search);
  $('q').value = p.get('q') ?? '';
  // `tipo` é o apelido curto que a landing usa nos botões Veículos e Imóveis.
  const tipo = p.get('tipo');
  if (tipo === 'veiculo' || tipo === 'imovel') $('assetType').value = tipo;
  for (const id of CAMPOS_FILTRO) {
    if (id === 'assetType' && tipo) continue;
    $(id).value = p.get(id) ?? '';
  }
  // Os de seleção múltipla são Set, não <select>: o valor do link entra direto,
  // sem depender de a faceta já ter sido pintada. Era esse o problema do
  // <select>, em que `value = 'SP'` sem a <option> correspondente virava ''.
  for (const id of Object.keys(MULTIS)) {
    state.multi[id] = new Set((p.get(id) ?? '').split(',').filter(Boolean));
    $(`${id}Resumo`).textContent = resumoMulti(id);
  }
  $('onlyWithDate').checked = p.get('onlyWithDate') === '1';
  $('onlyWithPhoto').checked = p.get('onlyWithPhoto') === '1';
  const sort = p.get('sort');
  $('sort').value = sort && [...$('sort').options].some((o) => o.value === sort) ? sort : 'ending_soon';
  state.page = Math.max(1, Number(p.get('page')) || 1);
  atualizaContadorFiltros();
}

window.addEventListener('popstate', () => {
  // Voltar para uma URL de busca diferente da tela atual tem de repintar os
  // filtros; voltar de um lote para a MESMA busca não deve refazer a consulta.
  const precisaBuscar = !location.pathname.startsWith('/lote/') && location.search !== `?${estadoDaTela()}`.replace(/\?$/, '');
  if (precisaBuscar) aplicarParametrosDaUrl();
  rotear(false);
  if (precisaBuscar) search();
});

for (const id of Object.keys(MULTIS)) montaMulti(id);
montaDialogoAlerta();
montaPainelFiltros();
aplicarParametrosDaUrl();
atualizaContadorFiltros();
// A aba Cobertura só é removida depois que o papel chega, então o roteamento
// espera: rotear antes deixaria o usuário comum numa aba que vai sumir.
aplicarPapel().then(() => rotear(false));
search();
connectWs();
carregarAlertas();
setInterval(() => {
  document.querySelectorAll('.card').forEach((el) => {
    const lot = state.lastItems.find((l) => String(l.id) === el.dataset.id);
    if (!lot) return;
    const w = whenLabel(lot);
    const node = el.querySelector('.when');
    node.textContent = w.text;
    node.className = `when ${w.cls}`;
  });
}, 30000);
