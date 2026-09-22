/**
 * Freio de coleta: para de bater numa fonte que já disse não.
 *
 * MEDIDO em 22/09: superbid recebeu 200 coletas em 48h, todas 403 — metade de
 * toda coleta do sistema. `decideFreio` é a função que interrompe isso, e é
 * pura de propósito: os três casos de borda (execução sem desfecho, sonda no
 * limite exato do descanso, contagem que reseta ao primeiro sucesso) não
 * pedem rede nenhuma para serem provados errados se a lógica regredir.
 */
import { decideFreio, FALHAS_PARA_FREAR, DESCANSO_FREIO_H } from '../src/core/freio.ts';

let falhas = 0;
const ok = (t, d = '') => console.log(`  OK    ${t}${d ? ` — ${d}` : ''}`);
const falha = (t, d) => {
  falhas++;
  console.log(`  FALHA ${t} — ${d}`);
};

const AGORA = new Date('2026-09-22T12:00:00Z');
const min = (n) => new Date(+AGORA - n * 60_000);
const h = (n) => new Date(+AGORA - n * 3_600_000);

/* 1 — o caso real: 200 falhas seguidas em 48h freiam */
{
  const historico = Array.from({ length: 200 }, (_, i) => ({ ok: false, startedAt: min(i * 14) }));
  const v = decideFreio(historico, AGORA);
  !v.permite && v.motivo === 'freado'
    ? ok('1. 200 falhas seguidas freiam', `seguidas=${v.seguidas}`)
    : falha('1. 200 falhas seguidas freiam', JSON.stringify(v));
}

/* 2 — abaixo do limite, nunca freia */
{
  const historico = Array.from({ length: FALHAS_PARA_FREAR - 1 }, (_, i) => ({ ok: false, startedAt: min(i * 10) }));
  const v = decideFreio(historico, AGORA);
  v.permite && v.motivo === 'normal'
    ? ok('2. abaixo do limite não freia', `${FALHAS_PARA_FREAR - 1} falhas seguidas`)
    : falha('2. abaixo do limite não freia', JSON.stringify(v));
}

/* 3 — um sucesso no meio reseta a contagem, mesmo com falhas ANTES dele */
{
  const historico = [
    { ok: true, startedAt: min(1) },
    ...Array.from({ length: 50 }, (_, i) => ({ ok: false, startedAt: min(10 + i) })),
  ];
  const v = decideFreio(historico, AGORA);
  v.permite && v.seguidas === 0
    ? ok('3. sucesso mais recente zera a contagem')
    : falha('3. sucesso mais recente zera a contagem', JSON.stringify(v));
}

/* 4 — execução sem desfecho (ok=null) não conta como falha NEM zera a
      contagem: um worker reiniciado no meio não pode soltar nem endurecer o freio. */
{
  const historico = [
    { ok: null, startedAt: min(1) },
    ...Array.from({ length: FALHAS_PARA_FREAR }, (_, i) => ({ ok: false, startedAt: min(10 + i) })),
  ];
  const v = decideFreio(historico, AGORA);
  !v.permite && v.seguidas === FALHAS_PARA_FREAR
    ? ok('4. execução sem desfecho é ignorada, não reseta nem some como falha', `seguidas=${v.seguidas}`)
    : falha('4. execução sem desfecho é ignorada, não reseta nem some como falha', JSON.stringify(v));
}

/* 5 — a sonda: exatamente no fim do descanso, passa UMA vez */
{
  const ultimaFalha = h(DESCANSO_FREIO_H);
  const historico = Array.from({ length: FALHAS_PARA_FREAR }, (_, i) => ({
    ok: false,
    startedAt: new Date(+ultimaFalha - i * 60_000),
  }));
  const antes = decideFreio(historico, new Date(+ultimaFalha + DESCANSO_FREIO_H * 3_600_000 - 1000));
  const depois = decideFreio(historico, new Date(+ultimaFalha + DESCANSO_FREIO_H * 3_600_000));
  !antes.permite && depois.permite && depois.motivo === 'sonda'
    ? ok('5. a sonda libera exatamente no fim do descanso, não antes')
    : falha('5. a sonda libera exatamente no fim do descanso, não antes', `antes=${JSON.stringify(antes)} depois=${JSON.stringify(depois)}`);
}

/* 6 — a sonda falhando reinicia o descanso a partir DELA, não da falha antiga */
{
  const sonda = h(DESCANSO_FREIO_H + 6); // a sonda em si, já passada
  const historico = [
    { ok: false, startedAt: sonda },
    ...Array.from({ length: FALHAS_PARA_FREAR }, (_, i) => ({ ok: false, startedAt: h(DESCANSO_FREIO_H + 6.1 + i) })),
  ];
  // 1h depois DA SONDA — ainda dentro do descanso que ela reabriu.
  const v = decideFreio(historico, new Date(+sonda + 3_600_000));
  !v.permite
    ? ok('6. sonda que falha de novo reinicia o descanso a partir dela')
    : falha('6. sonda que falha de novo reinicia o descanso a partir dela', JSON.stringify(v));
}

/* 7 — histórico vazio (fonte nova) nunca freia */
{
  const v = decideFreio([], AGORA);
  v.permite
    ? ok('7. fonte sem histórico não freia')
    : falha('7. fonte sem histórico não freia', JSON.stringify(v));
}

console.log(falhas ? `\n${falhas} falha(s)` : '\ntodas passaram');
process.exit(falhas ? 1 : 0);
