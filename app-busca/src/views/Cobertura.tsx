import { useEffect, useState } from 'react';
import type { Stats } from '@/lib/types';
import { api } from '@/lib/api';
import { pct } from '@/lib/format';

/** Rótulo das três contagens, que muda conforme a rotina que rodou. */
const LOTES: Array<[string, string]> = [
  ['lotes lidos na fonte', 'lidos'],
  ['lotes gravados no índice', 'gravados'],
  ['lotes descartados', 'descartados'],
];
const COLUNAS: Record<string, Array<[string, string]>> = {
  collect: LOTES,
  'collect:cli': LOTES,
  discover: [
    ['sites sondados', 'sondados'],
    ['com plataforma identificada', 'com plataforma'],
    ['fora do ar', 'fora do ar'],
  ],
};

export function Cobertura() {
  const [dados, setDados] = useState<Stats | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    api.stats().then(setDados).catch((e) => setErro(String(e?.message ?? e)));
  }, []);

  if (erro) return <main className="faixa sec"><div className="empty">Não foi possível carregar ({erro}).</div></main>;
  if (!dados) return <main className="faixa sec"><div className="empty">Carregando…</div></main>;

  const t = dados.totals;
  const cartoes: Array<[string, string]> = [
    ['Lotes no índice', t.lots.toLocaleString('pt-BR')],
    ['Abertos para lance', t.abertos.toLocaleString('pt-BR')],
    ['Agendados', t.agendados.toLocaleString('pt-BR')],
    ['Sem data definida', `${t.sem_data.toLocaleString('pt-BR')} (${pct(t.sem_data, t.lots)}%)`],
    ['Com encerramento por lote', `${t.com_fim.toLocaleString('pt-BR')} (${pct(t.com_fim, t.lots)}%)`],
    ['Com lance publicado', `${t.com_lance.toLocaleString('pt-BR')} (${pct(t.com_lance, t.lots)}%)`],
    ['Com quilometragem', `${t.com_km.toLocaleString('pt-BR')} (${pct(t.com_km, t.lots)}%)`],
    ['Marcas reconhecidas', String(t.marcas)],
    ['Veículos', t.veiculos.toLocaleString('pt-BR')],
    ['Imóveis', t.imoveis.toLocaleString('pt-BR')],
    ['Fora do escopo (peça, lote misto)', t.outros.toLocaleString('pt-BR')],
  ];

  return (
    <main className="faixa sec">
      <h1 className="page-head">Cobertura e saúde da coleta</h1>
      <p className="page-sub">
        Cada fonte tem lacunas conhecidas. Leilão em pregão ao vivo não tem encerramento por lote, e
        a Copart só publica data para uma fração do estoque. Esta tela existe para a lacuna ficar
        visível em vez de virar campo vazio na busca.
      </p>

      <div className="statgrid">
        {cartoes.map(([l, n]) => (
          <div className="stat" key={l}>
            <div className="n mono">{n}</div>
            <div className="l">{l}</div>
          </div>
        ))}
      </div>

      <h2 className="sub-head">Por fonte</h2>
      <div className="table-wrap">
        <table className="report">
          <thead>
            <tr>
              <th>Fonte</th><th>Lotes</th><th>Com fim por lote</th>
              <th>Com lance</th><th>Com km</th><th>Última coleta</th>
            </tr>
          </thead>
          <tbody>
            {dados.bySource.map((s) => (
              <tr key={s.source_id}>
                <td>{s.name}</td>
                <td className="mono">{s.lots.toLocaleString('pt-BR')}</td>
                <td className="mono">{s.com_fim} ({pct(s.com_fim, s.lots)}%)</td>
                <td className="mono">{s.com_lance} ({pct(s.com_lance, s.lots)}%)</td>
                <td className="mono">{s.com_km} ({pct(s.com_km, s.lots)}%)</td>
                <td className="mono">{s.ultima_coleta ? new Date(s.ultima_coleta).toLocaleString('pt-BR') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="sub-head">Últimas execuções de coleta</h2>
      <div className="table-wrap">
        <table className="report">
          <thead>
            <tr>
              <th>Fonte</th><th>Rotina</th><th>Início</th><th>Resultado</th>
              <th colSpan={3}>Contagem <span className="th-nota">(passe o mouse)</span></th>
            </tr>
          </thead>
          <tbody>
            {dados.runs.map((r, i) => {
              const cols = COLUNAS[r.job] ?? LOTES;
              const vals = [r.fetched, r.upserted, r.skipped];
              return (
                <tr key={`${r.source_id}-${r.started_at}-${i}`}>
                  <td>{r.source_id}</td>
                  <td>{r.job === 'discover' ? 'descoberta' : r.job}</td>
                  <td className="mono">{new Date(r.started_at).toLocaleString('pt-BR')}</td>
                  <td className={r.ok ? 'tag-ok' : r.ok === null ? '' : 'tag-bad'} title={r.error ?? ''}>
                    {r.ok === null ? 'em curso' : r.ok ? 'ok' : `falhou${r.http_status ? ` (HTTP ${r.http_status})` : ''}`}
                  </td>
                  {vals.map((v, j) => (
                    <td key={j} title={cols[j][0]} className="mono">
                      {v}
                      <span className="col-nota">{cols[j][1]}</span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
