/**
 * Landing de venda. Tudo que é número nesta página vem de /api/vitrine — o
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
  caminhao: '<path d="M14 18V6a2 2 0 00-2-2H4a2 2 0 00-2 2v11a1 1 0 001 1h2M15 18H9M19 18h2a1 1 0 001-1v-3.65a1 1 0 00-.22-.62l-3.48-4.35A1 1 0 0017.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
};
const svg = (nome) =>
  `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES[nome] ?? ICONES.martelo}</svg>`;

const imagem = (url, w) => `/api/img?u=${encodeURIComponent(url)}&w=${w}`;

/** A foto é de um lote real da categoria; sem nenhum com foto, o cartão fica no degradê. */
function pintaCategorias(cats) {
  $('cats').innerHTML = cats
    .map(
      (c) => `<a class="tipo${c.foto ? '' : ' sem-foto'}" href="/busca?${esc(c.query)}"${c.foto ? ` style="background-image:url('${esc(imagem(c.foto, 480))}')"` : ''}>
        <span class="tipo-ico">${svg(c.icone)}</span>
        <span class="tipo-txt"><b>${esc(c.label)}</b><span class="mono">${nInt(c.total)} lotes</span></span>
      </a>`,
    )
    .join('');
}

/**
 * Três lotes reais com foto e preço flutuando ao lado do título. Pregão que não
 * começou publica lance de abertura, e o rótulo diz isso em vez de "lance atual".
 */
function pintaPilha(lotes) {
  const comPreco = (lotes ?? []).filter((l) => l.photos?.length && (l.current_bid ?? l.min_bid) != null && !l.bid_suspect);
  $('heroPilha').innerHTML = comPreco
    .slice(0, 3)
    .map((l, i) => {
      const lance = l.current_bid ?? l.min_bid;
      const rotulo = l.current_bid != null ? (l.status === 'agendado' ? 'Lance inicial' : 'Lance atual') : 'Lance mínimo';
      const local = [l.city, l.state].filter(Boolean).join('/');
      return `<a class="hero-card ${['a', 'b', 'c'][i]}" href="/lote/${slugDoLote(l)}" tabindex="-1">
        <img src="${esc(imagem(l.photos[0], 480))}" alt="" loading="eager">
        <span class="hero-card-txt">
          <b>${esc(l.title_display || l.title_raw)}</b>
          <span class="mono">${esc(dinheiro(lance))}</span>
          <small>${esc([rotulo, local].filter(Boolean).join(' · '))}</small>
        </span>
      </a>`;
    })
    .join('');
}

function pintaNumeros(d) {
  const itens = [
    { v: d.total, rot: 'lotes em leilão agora', det: `${nInt(d.novos24h)} novos nas últimas 24h` },
    { v: d.totalLeiloeiros, rot: 'leiloeiros oficiais', det: 'só leilão oficial' },
    { v: d.ufs?.length, rot: 'estados com leilão aberto', det: 'de norte a sul' },
    { v: d.encerram24h, rot: 'lotes encerram nas próximas 24h', det: 'quem sabe antes, chega antes' },
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

/** O que o assinante ganha. Fala do resultado para ele, nunca de como o dado é obtido. */
const BENEFICIOS = [
  ['sino', 'Seja avisado primeiro', 'Salve “Hilux 4x4 no PR até R$ 120 mil” e receba o aviso quando entrar um lote que combine. Achar o lote a tempo é o que separa a oportunidade do arrependimento.'],
  ['busca', 'Tudo numa busca só', 'Imóveis e veículos de leilões de todo o Brasil no mesmo lugar, com filtros por modelo, cidade, preço e prazo.'],
  ['relogio', 'Prazo sempre à vista', 'Quando o leilão começa ou encerra, destacado em cada lote, para você nunca chegar tarde ao lance.'],
  ['etiqueta', 'Lance perto da avaliação', 'Veja quanto o lance representa da avaliação do bem e encontre as maiores diferenças primeiro.'],
  ['escudo', 'Só leilão oficial', 'Lotes de leiloeiros oficiais, judiciais e extrajudiciais, com o link direto para a página do leilão.'],
  ['elo', 'Sem comissão sobre o arremate', 'O Radar não intermedeia o lance. Você negocia direto com o leiloeiro e paga só a assinatura.'],
];
const ICONES_BENEFICIO = {
  busca: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  sino: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z"/><path d="M10 20a2 2 0 004 0"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  etiqueta: '<path d="M3 12l9-9 9 9-9 9z"/><circle cx="12" cy="9" r="1.5"/>',
  escudo: '<path d="M12 3l7 3v6c0 4-3 7.5-7 9-4-1.5-7-5-7-9V6z"/>',
  elo: '<path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1"/><path d="M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1"/>',
};
$('resolve').innerHTML = BENEFICIOS.map(
  ([ico, titulo, corpo]) => `<article class="cartao sobe">
    <span class="ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES_BENEFICIO[ico]}</svg></span>
    <h3>${esc(titulo)}</h3><p>${esc(corpo)}</p>
  </article>`,
).join('');

/* ------------------------------------------------------------------ */
/* Cadastro                                                            */
/* ------------------------------------------------------------------ */

/** Versão do texto de aceite: muda junto com o texto, e o servidor guarda as duas. */
const VERSAO_CONSENTIMENTO = '2026-10-02';
const digitos = (v) => String(v ?? '').replace(/\D/g, '');

function mascaraDocumento(v) {
  const d = digitos(v).slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
}
function mascaraCelular(v) {
  const d = digitos(v).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  const meio = d.length === 11 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, meio)}-${d.slice(meio)}`;
}
$('cadDocumento').addEventListener('input', (e) => { e.target.value = mascaraDocumento(e.target.value); });
$('cadCelular').addEventListener('input', (e) => { e.target.value = mascaraCelular(e.target.value); });

const formCadastro = $('formCadastro');
const avisoCadastro = $('avisoCadastro');
const CAMPO_DO_SERVIDOR = { nome: 'cadNome', documento: 'cadDocumento', email: 'cadEmail', celular: 'cadCelular', consentimento: 'cadAceite' };
const mostraAviso = (texto, ok) => {
  avisoCadastro.hidden = false;
  avisoCadastro.className = `aviso ${ok ? 'aviso-ok' : 'aviso-erro'}`;
  avisoCadastro.textContent = texto;
};
const erroNoCampo = (id, texto) => {
  mostraAviso(texto, false);
  $(id)?.focus();
};

formCadastro.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const nome = $('cadNome').value.trim();
  const documento = digitos($('cadDocumento').value);
  const email = $('cadEmail').value.trim();
  const celular = digitos($('cadCelular').value);
  // Checagem rápida só para poupar ida ao servidor; quem decide é o servidor.
  if (nome.split(/\s+/).filter(Boolean).length < 2) return erroNoCampo('cadNome', 'Informe nome e sobrenome.');
  if (documento.length !== 11 && documento.length !== 14) return erroNoCampo('cadDocumento', 'Informe um CPF ou CNPJ completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return erroNoCampo('cadEmail', 'Confira o e-mail: faltou o @ ou o domínio.');
  if (celular.length < 10) return erroNoCampo('cadCelular', 'Informe o celular com DDD.');
  if (!$('cadAceite').checked) return erroNoCampo('cadAceite', 'Para criar a conta, aceite os termos e a política de privacidade.');

  const btn = $('btnCadastro');
  btn.disabled = true;
  btn.textContent = 'Criando sua conta…';
  try {
    const r = await fetch('/api/cadastro', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nome,
        documento,
        email,
        celular,
        // O texto que a pessoa leu vai junto: é o que prova a base legal depois.
        consentimento: $('textoConsentimento').textContent.replace(/\s+/g, ' ').trim(),
        consentimentoVersao: VERSAO_CONSENTIMENTO,
        marketing: $('cadMarketing').checked,
        origem: new URLSearchParams(location.search).get('utm_source') || 'landing',
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const id = CAMPO_DO_SERVIDOR[d.campo];
      return id ? erroNoCampo(id, d.erro ?? 'Confira os dados.') : mostraAviso(d.erro ?? 'Não foi possível criar a conta agora.', false);
    }
    mostraAviso(d.mensagem ?? 'Cadastro recebido! Em seguida você recebe o link para ativar a assinatura.', true);
    formCadastro.reset();
  } catch {
    mostraAviso('Não foi possível enviar agora. Confira sua conexão e tente de novo.', false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Criar minha conta';
  }
});

/* ------------------------------------------------------------------ */

async function iniciar() {
  observar();
  let d;
  try {
    d = await (await fetch('/api/vitrine')).json();
  } catch {
    return;
  }
  $('heroLotes').textContent = nInt(d.total);
  $('cadastroLotes').textContent = nInt(d.total);

  pintaCategorias(d.categorias ?? []);
  pintaNumeros(d);
  pintaPilha(d.recentes);
  pintaLotes(d.recentes);

  $('ufs').innerHTML = (d.ufs ?? [])
    .map((u) => `<a class="uf" href="/busca?uf=${esc(u.uf)}">${esc(u.uf)} <b>${nInt(u.total)}</b></a>`)
    .join('');

  observar();
}

iniciar();
