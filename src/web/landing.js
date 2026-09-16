/**
 * Landing de venda. Tudo que é número nesta página vem de /api/landing — o
 * mockup do design trazia 21.943 lotes e 116 leiloeiros escritos no HTML, e
 * número chumbado numa landing de agregador envelhece em horas e vira mentira
 * na primeira busca de quem leu.
 *
 * O GSAP do export fazia contador e stagger; aqui é IntersectionObserver +
 * requestAnimationFrame, sem dependência.
 */
const $ = (id) => document.getElementById(id);

// Marca já: o CSS só esconde o que este script se comprometeu a revelar.
document.documentElement.classList.add('js-anima');

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nInt = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const dinheiro = (v) =>
  v == null ? null : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);

const semAnimacao = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ */
/* Entrada em cena                                                     */
/* ------------------------------------------------------------------ */

/**
 * Entrada em cena.
 *
 * O que está na primeira tela revela na hora; o resto espera o IntersectionObserver.
 *
 * Medido: quando TUDO dependia do observador, `.busca-caixa` e `.hero-provas`
 * ficavam presas em opacity 0 para sempre. O observador dispara uma vez, durante
 * o primeiro layout — naquele instante `.hero-sub`, inteira na tela, reportou
 * razão 0,396 e as duas de baixo reportaram 0 — e, como a posição delas em
 * relação ao root não muda depois, ele nunca reamostra. Conteúdo invisível é
 * pior do que conteúdo sem animação, então há também uma rede de segurança por
 * tempo: nada fica escondido além de 1,2 s, aconteça o que acontecer.
 */
const observador = new IntersectionObserver(
  (entradas) => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('visivel');
      observador.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
);

const revelar = (el) => {
  el.classList.add('visivel');
  observador.unobserve(el);
};

function observar(raiz = document) {
  for (const el of raiz.querySelectorAll('.sobe:not(.visivel)')) {
    // Já está na primeira tela: não há o que esperar, e esperar foi o bug.
    if (el.getBoundingClientRect().top < window.innerHeight) revelar(el);
    else observador.observe(el);
  }
}

// Rede de segurança: passado o tempo da primeira impressão, o que ainda estiver
// escondido aparece — sem recorte de posição. Um print de página inteira não
// rola, então o observador nunca dispara para o que está lá embaixo, e a seção
// saía em branco. Perder a animação é barato; perder o texto, não.
setTimeout(() => {
  for (const el of document.querySelectorAll('.sobe:not(.visivel)')) revelar(el);
}, 1500);

/** Contador do zero até o valor. Sem tween: a curva é a mesma power2.out do export. */
function contar(el, valor) {
  if (semAnimacao || valor == null) {
    el.textContent = nInt(valor);
    return;
  }
  const dur = 1700;
  const t0 = performance.now();
  const passo = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    el.textContent = nInt(Math.round(valor * (1 - (1 - p) ** 3)));
    if (p < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

/* ------------------------------------------------------------------ */
/* Cabeçalho                                                           */
/* ------------------------------------------------------------------ */

const btnMenu = $('btnMenu');
const menuMovel = $('menuMovel');
btnMenu.onclick = () => {
  const aberto = menuMovel.dataset.aberto === '1';
  menuMovel.dataset.aberto = aberto ? '0' : '1';
  btnMenu.setAttribute('aria-expanded', String(!aberto));
  btnMenu.setAttribute('aria-label', aberto ? 'Abrir menu' : 'Fechar menu');
};
for (const a of menuMovel.querySelectorAll('a')) {
  a.addEventListener('click', () => {
    menuMovel.dataset.aberto = '0';
    btnMenu.setAttribute('aria-expanded', 'false');
  });
}

/* ------------------------------------------------------------------ */
/* Conteúdo                                                            */
/* ------------------------------------------------------------------ */

const ICONES = {
  carro: '<path d="M5 17h14M4 17l1.5-5A2 2 0 017.4 10h9.2a2 2 0 011.9 1.4L20 17M4 17v2M20 17v2"/><circle cx="7.5" cy="16.5" r="1.5"/><circle cx="16.5" cy="16.5" r="1.5"/>',
  casa: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  moto: '<circle cx="5.5" cy="17" r="3"/><circle cx="18.5" cy="17" r="3"/><path d="M8.5 17h5l3-7h-3M13 6h3l1 4"/>',
  maquina: '<path d="M4 18h10l3-5h4v5"/><path d="M4 18V9h6v4"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="19" r="2"/>',
  martelo: '<path d="M14 4l6 6M3 21l3-1 11-11-2-2L4 18z"/><path d="M12 3l3 3"/>',
};
const svg = (nome) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nome] ?? ICONES.martelo}</svg>`;

/** O chip filtra a busca do hero; o link da categoria leva à busca já filtrada. */
function pintaCategorias(cats) {
  $('cats').innerHTML = cats
    .map(
      (c) => `<a class="cat" href="/busca?${esc(c.query)}">
        <span class="ico">${svg(c.icone)}</span>
        <b>${esc(c.label)}</b>
        <small>${esc(c.dica)}</small>
        <span class="qtd">${nInt(c.total)} lotes abertos</span>
      </a>`,
    )
    .join('');

  const chips = $('chips');
  chips.innerHTML = [{ id: 'todos', label: 'Todas as categorias', query: '' }, ...cats]
    .map(
      (c, i) =>
        `<button class="chip" type="button" data-query="${esc(c.query ?? '')}" aria-pressed="${i === 0}">
           ${c.icone ? svg(c.icone).replace('width="20" height="20"', 'width="14" height="14"') : ''}${esc(c.label)}
         </button>`,
    )
    .join('');

  // O chip não recarrega nada: ele guarda o recorte que o submit da busca vai usar.
  let escolhido = '';
  for (const b of chips.querySelectorAll('.chip')) {
    b.onclick = () => {
      for (const o of chips.querySelectorAll('.chip')) o.setAttribute('aria-pressed', String(o === b));
      escolhido = b.dataset.query;
    };
  }
  $('formBusca').addEventListener('submit', (ev) => {
    if (!escolhido) return;
    ev.preventDefault();
    const p = new URLSearchParams(escolhido);
    const q = $('q').value.trim();
    if (q) p.set('q', q);
    window.location.href = `/busca?${p}`;
  });
}

function pintaNumeros(d) {
  const itens = [
    { v: d.total, rot: 'lotes no índice agora', det: `${nInt(d.novos24h)} nas últimas 24h` },
    { v: d.totalLeiloeiros, rot: 'leiloeiros oficiais mapeados', det: `${nInt(d.ufs?.length)} estados` },
    { v: d.fontes, rot: 'plataformas de leilão integradas', det: 'uma busca só' },
    { v: d.encerram24h, rot: 'lotes encerram nas próximas 24h', det: 'prazo da própria fonte' },
  ];
  $('numeros').innerHTML = itens
    .map(
      (i) => `<div>
        <dt class="mono" data-valor="${i.v ?? ''}">0</dt>
        <dd>${esc(i.rot)}</dd>
        <dd class="det"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>${esc(i.det)}</dd>
      </div>`,
    )
    .join('');

  // O contador corre quando a faixa entra na tela — animar fora de vista gasta
  // quadro e o usuário perde justamente o efeito. Mas "0 lotes no índice" numa
  // landing é pior que qualquer animação perdida, então há prazo: passado ele,
  // os números aparecem prontos, com ou sem observador.
  const faixa = $('numeros');
  let correu = false;
  const correr = () => {
    if (correu) return;
    correu = true;
    obs.disconnect();
    for (const dt of faixa.querySelectorAll('dt')) contar(dt, Number(dt.dataset.valor) || 0);
  };
  const obs = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && correr(), { threshold: 0.35 });
  obs.observe(faixa);
  setTimeout(() => {
    if (correu) return;
    correu = true;
    obs.disconnect();
    for (const dt of faixa.querySelectorAll('dt')) dt.textContent = nInt(Number(dt.dataset.valor) || 0);
  }, 1500);
}

/**
 * Painel "encerrando agora". O mockup tinha um contador de lances por minuto
 * subindo sozinho; não recebemos lance nenhum, então o painel mostra o que é
 * verdade e igualmente urgente: o que encerra primeiro e quantos encerram por hora.
 */
function pintaPainel(d) {
  const lotes = d.encerrando ?? [];
  $('painelJanela').textContent = `${nInt(d.encerram24h)} em 24h`;

  if (!lotes.length) {
    $('painelNome').textContent = 'Nenhum lote com prazo definido agora.';
    $('painelValor').textContent = '—';
    return;
  }
  const p = lotes[0];
  $('painelValor').textContent = dinheiro(p.current_bid ?? p.min_bid) ?? 'sem lance publicado';
  $('painelNome').textContent = p.title_display || p.title_raw;
  $('painelOnde').textContent = [[p.city, p.state].filter(Boolean).join('/'), p.quando].filter(Boolean).join(' · ');

  $('feed').innerHTML = lotes
    .slice(1, 5)
    .map(
      (l) => `<li>
        <span class="txt">
          <b>${esc(l.title_display || l.title_raw)}</b>
          <small>${esc([[l.city, l.state].filter(Boolean).join('/'), l.quando].filter(Boolean).join(' · '))}</small>
        </span>
        <span class="v">${esc(dinheiro(l.current_bid ?? l.min_bid) ?? '—')}</span>
      </li>`,
    )
    .join('');

  const horas = d.porHora ?? [];
  const teto = Math.max(1, ...horas);
  $('barras').innerHTML = horas
    .map((n, i) => `<i style="height:${Math.max(6, Math.round((n / teto) * 100))}%" title="${n} encerram em ${i + 1}h"></i>`)
    .join('');
}

function pintaLeiloeiros(lista) {
  $('leiloeirosGrade').innerHTML = (lista ?? [])
    .slice(0, 12)
    .map((l) => {
      const iniciais = String(l.nome)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0])
        .join('')
        .toUpperCase();
      return `<a class="leiloeiro" href="/busca?auctioneer=${encodeURIComponent(l.nome)}">
        <span class="av">${esc(iniciais)}</span>
        <span class="txt"><b>${esc(l.nome)}</b><small>${nInt(l.total)} lotes abertos</small></span>
      </a>`;
    })
    .join('');
}

function pintaLotes(lotes) {
  const grade = $('lotesGrade');
  grade.innerHTML = '';
  for (const l of (lotes ?? []).slice(0, 8)) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = `/lote/${slugDoLote(l)}`;
    a.innerHTML = Cartao.conteudo(l);
    Cartao.attachImgFallback(a);
    grade.appendChild(a);
  }
}

/** Os textos da seção "o que o Radar faz" — só o que o sistema faz hoje. */
const RESOLVE = [
  ['busca', 'Busca que entende o modelo', '“t-cross”, “T CROSS” e “tcross” são a mesma coisa aqui. Na fonte, não são: a mesma consulta devolve zero num site e cinco no outro. Marca, modelo e ano são normalizados antes de indexar.'],
  ['sino', 'Alerta por busca salva', 'Salve “Hilux 4x4 no PR até R$ 120 mil” e receba aviso quando um lote novo casar. É o que separa achar o lote de achar o lote a tempo.'],
  ['relogio', 'Prazo que não mente', 'Leilão tem três modelos de encerramento: timer por lote, pregão em horário marcado e encerramento sequencial. Contagem regressiva nos três seria mentira — mostramos o que cada fonte garante.'],
  ['etiqueta', 'Desconto sobre a avaliação', 'Quando a fonte publica a avaliação, calculamos a diferença para o lance e sinalizamos o lote — sempre com a ressalva de que avaliação não é preço de venda.'],
  ['escudo', 'Dado pessoal mascarado na entrada', 'Placa, chassi, RENAVAM e número de motor são mascarados antes de qualquer indexação. Algumas fontes publicam esses campos em claro; no índice eles não entram assim.'],
  ['elo', 'Link direto para o leiloeiro', 'O Radar não intermedeia lance nem recebe pagamento. Cada lote leva à página original, no site de quem está leiloando, com o crédito da foto para quem a publicou.'],
];
const ICONES_RESOLVE = {
  busca: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  sino: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 004 0"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  etiqueta: '<path d="M3 12l9-9 9 9-9 9z"/><circle cx="12" cy="9" r="1.5"/>',
  escudo: '<path d="M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6z"/>',
  elo: '<path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>',
};
$('resolve').innerHTML = RESOLVE.map(
  ([ico, titulo, corpo]) => `<article class="cartao sobe">
    <span class="ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES_RESOLVE[ico]}</svg></span>
    <h3>${esc(titulo)}</h3><p>${esc(corpo)}</p>
  </article>`,
).join('');

/* ------------------------------------------------------------------ */
/* Lista de espera                                                     */
/* ------------------------------------------------------------------ */

const formEspera = $('formEspera');
const avisoEspera = $('avisoEspera');
const mostraAviso = (texto, ok) => {
  avisoEspera.hidden = false;
  avisoEspera.className = `aviso ${ok ? 'aviso-ok' : 'aviso-erro'}`;
  avisoEspera.textContent = texto;
};

formEspera.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('espEmail').value.trim();
  // A validação nativa não roda com novalidate; o e-mail é o único campo obrigatório.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    mostraAviso('Confira o e-mail: faltou o @ ou o domínio.', false);
    $('espEmail').focus();
    return;
  }
  const btn = $('btnEspera');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try {
    const r = await fetch('/api/espera', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        nome: $('espNome').value.trim(),
        interesse: $('espInteresse').value,
        // O texto que a pessoa leu vai junto: é o que prova a base legal depois.
        consentimento: $('textoConsentimento').textContent.replace(/\s+/g, ' ').trim(),
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro ?? 'falhou');
    mostraAviso(
      d.jaEstava
        ? 'Você já estava na lista — não vamos duplicar o aviso.'
        : 'Pronto. Você entrou na lista e será avisado quando o cadastro abrir.',
      true,
    );
    formEspera.reset();
  } catch (e) {
    mostraAviso(`Não foi possível enviar agora (${e.message}). Tente de novo em instantes.`, false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar na lista de espera';
  }
});

/* ------------------------------------------------------------------ */

async function iniciar() {
  observar();
  let d;
  try {
    d = await (await fetch('/api/landing')).json();
  } catch {
    $('painelNome').textContent = 'Não foi possível carregar o índice agora.';
    return;
  }
  $('heroFontes').textContent = nInt(d.fontes);
  $('heroLotes').textContent = nInt(d.total);
  $('esperaLotes').textContent = nInt(d.total);
  $('seloLeiloeiros').textContent = nInt(d.totalLeiloeiros);

  pintaCategorias(d.categorias ?? []);
  pintaNumeros(d);
  pintaPainel(d);
  pintaLeiloeiros(d.leiloeiros);
  pintaLotes(d.recentes);

  $('ufs').innerHTML = (d.ufs ?? [])
    .map((u) => `<a class="uf" href="/busca?uf=${esc(u.uf)}">${esc(u.uf)} <b>${nInt(u.total)}</b></a>`)
    .join('');

  observar();
}

iniciar();
