const $ = (id) => document.getElementById(id);

// Mesmo cartão da busca, mesmo crédito de foto, mesmo selo de desconto.
const { esc } = Cartao;

function cartao(lot) {
  const a = document.createElement('a');
  a.className = 'card carr-item';
  a.href = `/lote/${slugDoLote(lot)}`;
  a.innerHTML = Cartao.conteudo(lot);
  Cartao.attachImgFallback(a);
  return a;
}

function pinta(trilho, lotes, vazio) {
  trilho.innerHTML = '';
  if (!lotes.length) {
    trilho.innerHTML = `<p class="carr-vazio">${esc(vazio)}</p>`;
  } else {
    for (const l of lotes) trilho.appendChild(cartao(l));
  }
  atualizaSetas(trilho.closest('[data-carrossel]'));
}

/**
 * As setas só aparecem quando há o que rolar. No celular o dedo já resolve,
 * e seta desabilitada ocupando espaço em tela de 400px é ruído.
 */
function atualizaSetas(carr) {
  if (!carr) return;
  const trilho = carr.querySelector('.carr-trilho');
  const sobra = trilho.scrollWidth - trilho.clientWidth;
  const prev = carr.querySelector('.prev');
  const next = carr.querySelector('.next');
  const podeRolar = sobra > 8;
  prev.hidden = !podeRolar || trilho.scrollLeft <= 4;
  next.hidden = !podeRolar || trilho.scrollLeft >= sobra - 4;
}

for (const carr of document.querySelectorAll('[data-carrossel]')) {
  const trilho = carr.querySelector('.carr-trilho');
  const passo = () => Math.max(240, trilho.clientWidth * 0.8);
  carr.querySelector('.prev').onclick = () => trilho.scrollBy({ left: -passo(), behavior: 'smooth' });
  carr.querySelector('.next').onclick = () => trilho.scrollBy({ left: passo(), behavior: 'smooth' });
  trilho.addEventListener('scroll', () => atualizaSetas(carr), { passive: true });
}
window.addEventListener('resize', () => document.querySelectorAll('[data-carrossel]').forEach(atualizaSetas));

async function carregarLeiloeiro(nome) {
  const trilho = $('trilhoLeiloeiro');
  trilho.innerHTML = '<p class="carr-vazio">Carregando…</p>';
  try {
    const r = await fetch(`/api/home/leiloeiro?nome=${encodeURIComponent(nome)}`);
    pinta(trilho, await r.json(), 'Este leiloeiro não tem lote aberto no índice agora.');
  } catch {
    trilho.innerHTML = '<p class="carr-vazio">Não foi possível carregar os lotes deste leiloeiro.</p>';
  }
}

async function iniciar() {
  let dados;
  try {
    dados = await (await fetch('/api/home')).json();
  } catch {
    $('trilhoRecentes').innerHTML = '<p class="carr-vazio">Não foi possível carregar os lotes agora.</p>';
    return;
  }
  pinta($('trilhoRecentes'), dados.recentes ?? [], 'Nenhum lote mapeado ainda.');
  // Os números da prova social saem da base, não do texto: uma landing que
  // promete 20 mil lotes e entrega 300 queima na primeira busca.
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
  $('heroFontes').textContent = n(dados.fontes);
  $('heroLotes').textContent = n(dados.total);
  $('heroLeiloeiros').textContent = n(dados.totalLeiloeiros);
  $('heroUfs').textContent = n(dados.ufs?.length);
  const ufs = $('ufs');
  if (ufs) {
    ufs.innerHTML = (dados.ufs ?? [])
      .map((u) => `<a class="lp-uf" href="/busca?uf=${esc(u.uf)}">${esc(u.uf)} <b>${n(u.total)}</b></a>`)
      .join('');
  }

  const sel = $('selLeiloeiro');
  const leiloeiros = dados.leiloeiros ?? [];
  if (!leiloeiros.length) {
    sel.hidden = true;
    $('trilhoLeiloeiro').innerHTML = '<p class="carr-vazio">Nenhuma fonte publica o nome do leiloeiro nos lotes abertos.</p>';
    return;
  }
  sel.innerHTML = leiloeiros
    .map((l) => `<option value="${esc(l.nome)}">${esc(l.nome)} (${l.total})</option>`)
    .join('');
  sel.onchange = () => carregarLeiloeiro(sel.value);
  carregarLeiloeiro(leiloeiros[0].nome);
}

iniciar();
