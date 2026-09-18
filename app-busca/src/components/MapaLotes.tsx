import { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, Maximize2 } from 'lucide-react';
import type { PontoMapa, RespostaMapa } from '@/lib/types';
import { api } from '@/lib/api';

interface Props {
  dados: RespostaMapa | null;
  carregando: boolean;
  local: string;
  aoEscolherLocal: (k: string) => void;
  /** UF única selecionada nos filtros — acende o estado no desenho. */
  ufAtiva?: string;
}

interface AnelUf { uf: string; a: number[][]; c?: [number, number]; s?: number }
interface Municipio { n: string; a: number[] }
interface MunUf { uf: string; m: Municipio[] }

/** Malha do IBGE: a de UF vem sempre, a de município só quando alguém aproxima. */
let malhaUf: AnelUf[] | null = null;
let malhaMun: MunUf[] | null = null;
let pedindoMun = false;

const mercX = (lon: number) => (lon * Math.PI) / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
/** Divisa municipal a partir daqui: abaixo disso são 5.570 polígonos virando ruído. */
const ZOOM_MUNICIPIO = 4.5;
const ZOOM_NOME_MUNICIPIO = 14;

const fmt = new Intl.NumberFormat('pt-BR');

export function MapaLotes({ dados, carregando, local, aoEscolherLocal, ufAtiva }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const palco = useRef<HTMLDivElement>(null);
  const vista = useRef({ k: 1, x: 0, y: 0 });
  const base = useRef({ esc: 1, dx: 0, dy: 0, w: 0, h: 0 });
  const grupos = useRef<Array<{ x: number; y: number; n: number; itens: PontoMapa[] }>>([]);
  const [malhaPronta, setMalhaPronta] = useState(!!malhaUf);
  const [dica, setDica] = useState<{ x: number; y: number; html: string } | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (malhaUf) return;
    let vivo = true;
    api.malha<AnelUf[]>('uf').then((m) => { malhaUf = m; if (vivo) setMalhaPronta(true); }).catch(() => {});
    return () => { vivo = false; };
  }, []);

  const enquadra = useCallback(() => {
    const cv = ref.current;
    if (!cv || !malhaUf) return;
    const r = cv.getBoundingClientRect();
    const b = base.current;
    b.w = Math.max(1, r.width);
    b.h = Math.max(1, r.height);
    let o = 1e9, l = -1e9, s = 1e9, n = -1e9;
    for (const u of malhaUf) for (const a of u.a) for (let i = 0; i < a.length; i += 2) {
      if (a[i] < o) o = a[i]; if (a[i] > l) l = a[i];
      if (a[i + 1] < s) s = a[i + 1]; if (a[i + 1] > n) n = a[i + 1];
    }
    const pad = 24;
    // A tela cresce para baixo e a latitude para cima: sem inverter, a altura do
    // enquadramento sai negativa e quase todo ponto cai fora do canvas.
    const x0 = mercX(o), x1 = mercX(l), yT = mercY(n), yB = mercY(s);
    b.esc = Math.min((b.w - pad * 2) / (x1 - x0), (b.h - pad * 2) / (yT - yB));
    b.dx = (b.w - (x1 - x0) * b.esc) / 2 - x0 * b.esc;
    b.dy = (b.h - (yT - yB) * b.esc) / 2 + yT * b.esc;
  }, []);

  const tela = useCallback((lat: number, lon: number) => {
    const b = base.current, v = vista.current;
    return { x: (mercX(lon) * b.esc + b.dx) * v.k + v.x, y: (b.dy - mercY(lat) * b.esc) * v.k + v.y };
  }, []);

  const raio = (n: number) => Math.max(4.5, Math.min(34, 3.4 + Math.sqrt(n) * 1.25));

  const desenha = useCallback(() => {
    const cv = ref.current;
    if (!cv || !malhaUf) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const b = base.current, v = vista.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = cv.getBoundingClientRect();
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, b.w, b.h);

    for (const u of malhaUf) {
      const alvo = !!ufAtiva && u.uf === ufAtiva;
      ctx.beginPath();
      for (const a of u.a) {
        for (let i = 0; i < a.length; i += 2) {
          const t = tela(a[i + 1], a[i]);
          if (i === 0) ctx.moveTo(t.x, t.y); else ctx.lineTo(t.x, t.y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = alvo ? 'rgba(47,107,255,0.16)' : 'rgba(18,27,49,0.72)';
      ctx.fill();
      ctx.strokeStyle = alvo ? 'rgba(91,140,255,0.9)' : 'rgba(40,55,88,0.95)';
      ctx.lineWidth = alvo ? 1.6 : 0.9;
      ctx.stroke();
    }

    if (v.k >= ZOOM_MUNICIPIO && malhaMun) {
      ctx.strokeStyle = 'rgba(60,80,120,0.55)';
      ctx.lineWidth = 0.7;
      const nomear = v.k >= ZOOM_NOME_MUNICIPIO;
      if (nomear) { ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(147,164,196,0.55)'; ctx.font = '10px "DM Sans", sans-serif'; }
      for (const uf of malhaMun) {
        if (ufAtiva && uf.uf !== ufAtiva && v.k >= 8) continue;
        for (const m of uf.m) {
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          ctx.beginPath();
          for (let i = 0; i < m.a.length; i += 2) {
            const t = tela(m.a[i + 1], m.a[i]);
            if (t.x < x0) x0 = t.x; if (t.x > x1) x1 = t.x;
            if (t.y < y0) y0 = t.y; if (t.y > y1) y1 = t.y;
            if (i === 0) ctx.moveTo(t.x, t.y); else ctx.lineTo(t.x, t.y);
          }
          if (x1 < 0 || y1 < 0 || x0 > b.w || y0 > b.h) continue;
          ctx.closePath();
          ctx.stroke();
          if (nomear && x1 - x0 > 58) ctx.fillText(m.n, (x0 + x1) / 2, (y0 + y1) / 2);
        }
      }
      if (nomear) { ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const u of malhaUf) {
      if (!u.c || !u.s) continue;
      const lado = Math.sqrt(u.s) * b.esc * v.k * 0.0175;
      if (lado < 26) continue;
      const c = tela(u.c[1], u.c[0]);
      if (c.x < -20 || c.y < -20 || c.x > b.w + 20 || c.y > b.h + 20) continue;
      ctx.font = `600 ${Math.max(10, Math.min(19, lado * 0.2))}px "Space Grotesk", sans-serif`;
      ctx.fillStyle = ufAtiva === u.uf ? 'rgba(238,243,255,0.5)' : 'rgba(147,164,196,0.32)';
      ctx.fillText(u.uf, c.x, c.y);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    // Agrupamento em grade de 45px: é o menor passo em que dois pontos ainda se
    // distinguem, e é o que impede 1.484 círculos empilhados no mesmo pixel.
    const cel = 45;
    const mapa = new Map<string, { x: number; y: number; n: number; itens: PontoMapa[] }>();
    for (const p of dados?.pontos ?? []) {
      const t = tela(p.lat, p.lon);
      if (t.x < -80 || t.y < -80 || t.x > b.w + 80 || t.y > b.h + 80) continue;
      const k = `${Math.floor(t.x / cel)}:${Math.floor(t.y / cel)}`;
      let g = mapa.get(k);
      if (!g) { g = { x: 0, y: 0, n: 0, itens: [] }; mapa.set(k, g); }
      g.x += t.x * p.n; g.y += t.y * p.n; g.n += p.n; g.itens.push(p);
    }
    const lista = [...mapa.values()];
    for (const g of lista) { g.x /= g.n || 1; g.y /= g.n || 1; }
    grupos.current = lista;

    for (const g of lista) {
      const unico = g.itens.length === 1 ? g.itens[0] : null;
      const rr = raio(g.n);
      const ehCidade = unico ? unico.camada === 'cidade' : g.itens.some((i) => i.camada === 'cidade');
      if (ehCidade) {
        const grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, rr * 1.9);
        grad.addColorStop(0, 'rgba(47,107,255,0.34)');
        grad.addColorStop(1, 'rgba(47,107,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(g.x, g.y, rr * 1.9, 0, 6.2832); ctx.fill();
        ctx.strokeStyle = 'rgba(91,140,255,0.85)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(g.x, g.y, rr, 0, 6.2832); ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = 'rgba(34,211,238,0.22)';
        ctx.beginPath(); ctx.arc(g.x, g.y, rr * 1.7, 0, 6.2832); ctx.fill();
        ctx.fillStyle = '#22d3ee';
        ctx.beginPath(); ctx.arc(g.x, g.y, rr, 0, 6.2832); ctx.fill();
      }
      const chaveG = g.itens.map((i) => i.k).join(';');
      if (local && chaveG === local) {
        ctx.strokeStyle = '#eef3ff';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(g.x, g.y, rr + 5, 0, 6.2832); ctx.stroke();
      }
      if (g.n >= 40 && rr >= 13) {
        ctx.fillStyle = '#05070f';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `600 ${Math.min(13, rr * 0.8)}px "JetBrains Mono", monospace`;
        ctx.fillText(g.n >= 1000 ? `${(g.n / 1000).toFixed(1).replace('.', ',')}k` : String(g.n), g.x, g.y + 0.5);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    }

    const noMapa = lista.reduce((t, g) => t + g.n, 0);
    setStatus(
      `${fmt.format(noMapa)} lotes · ${fmt.format(lista.length)} pontos · ${v.k.toFixed(1)}×` +
        (v.k >= ZOOM_MUNICIPIO ? ' · divisa municipal' : ''),
    );
  }, [dados, local, tela, ufAtiva]);

  useEffect(() => { enquadra(); desenha(); }, [enquadra, desenha, malhaPronta]);
  useEffect(() => {
    const onR = () => { enquadra(); desenha(); };
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, [enquadra, desenha]);

  const zoom = useCallback((cx: number, cy: number, f: number) => {
    const v = vista.current;
    // Sem teto de aproximação: o limite existe só para o número não estourar.
    const novo = Math.max(1, Math.min(4000, v.k * f));
    const g = novo / v.k;
    v.x = cx - (cx - v.x) * g;
    v.y = cy - (cy - v.y) * g;
    v.k = novo;
    if (novo >= ZOOM_MUNICIPIO && !malhaMun && !pedindoMun) {
      pedindoMun = true;
      api.malha<MunUf[]>('municipio').then((m) => { malhaMun = m; desenha(); }).catch(() => {}).finally(() => { pedindoMun = false; });
    }
    setDica(null);
    desenha();
  }, [desenha]);

  const acha = (mx: number, my: number) => {
    let melhor = null as (typeof grupos.current)[number] | null;
    let dmin = 1e9;
    for (const g of grupos.current) {
      const d = Math.hypot(g.x - mx, g.y - my);
      const lim = raio(g.n) + 8;
      if (d <= lim && d < dmin) { dmin = d; melhor = g; }
    }
    return melhor;
  };

  /** Dois pontos a menos de 6px na tela não se separam com mais aproximação. */
  const espalhados = (itens: PontoMapa[]) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of itens) {
      const t = tela(p.lat, p.lon);
      x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x);
      y0 = Math.min(y0, t.y); y1 = Math.max(y1, t.y);
    }
    return Math.max(x1 - x0, y1 - y0) > 6;
  };

  const arrast = useRef({ on: false, moveu: false, px: 0, py: 0 });

  return (
    <div className="mapa-palco" ref={palco}>
      <canvas
        ref={ref}
        className="mapa-canvas"
        tabIndex={0}
        aria-label="Mapa dos lotes por cidade e pátio"
        onPointerDown={(e) => {
          arrast.current = { on: true, moveu: false, px: e.clientX, py: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - r.left, my = e.clientY - r.top;
          const a = arrast.current;
          if (a.on) {
            const dx = e.clientX - a.px, dy = e.clientY - a.py;
            if (Math.abs(dx) + Math.abs(dy) > 3) a.moveu = true;
            vista.current.x += dx; vista.current.y += dy;
            a.px = e.clientX; a.py = e.clientY;
            setDica(null);
            desenha();
            return;
          }
          const g = acha(mx, my);
          if (!g) { setDica(null); return; }
          const u = g.itens.length === 1 ? g.itens[0] : null;
          setDica({
            x: mx, y: my,
            html: u
              ? `<b>${u.cidade ?? 'Sem cidade'}${u.uf ? ` · ${u.uf}` : ''}</b><em>${fmt.format(u.n)} lotes · ${u.camada === 'patio' ? 'coordenada do pátio' : 'posição aproximada pela cidade'}</em>`
              : `<b>${fmt.format(g.n)} lotes</b><em>${g.itens.length} lugares · clique para aproximar</em>`,
          });
        }}
        onPointerUp={(e) => {
          const a = arrast.current;
          if (!a.on) return;
          a.on = false;
          if (a.moveu) return;
          const r = e.currentTarget.getBoundingClientRect();
          const g = acha(e.clientX - r.left, e.clientY - r.top);
          if (!g) { aoEscolherLocal(''); return; }
          // Aproximar só resolve o que ESTÁ separado. Cidade com um pátio só tem
          // a âncora em cima dele: os dois pontos nunca se afastam, e continuar
          // dando zoom seria um clique que não faz nada.
          const k = g.itens.map((i) => i.k).join(';');
          if (g.itens.length > 1 && espalhados(g.itens)) { zoom(g.x, g.y, 1.9); return; }
          aoEscolherLocal(k === local ? '' : k);
        }}
        onPointerLeave={() => setDica(null)}
        onWheel={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          zoom(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.22 : 1 / 1.22);
        }}
        onKeyDown={(e) => {
          const v = vista.current, p = 60;
          if (e.key === 'ArrowLeft') v.x += p;
          else if (e.key === 'ArrowRight') v.x -= p;
          else if (e.key === 'ArrowUp') v.y += p;
          else if (e.key === 'ArrowDown') v.y -= p;
          else if (e.key === '+' || e.key === '=') return zoom(base.current.w / 2, base.current.h / 2, 1.5);
          else if (e.key === '-') return zoom(base.current.w / 2, base.current.h / 2, 1 / 1.5);
          else if (e.key === 'Escape') return aoEscolherLocal('');
          else return;
          e.preventDefault();
          desenha();
        }}
      />

      {dica && (
        <div className="mapa-dica" style={{ left: Math.min(dica.x + 14, base.current.w - 240), top: Math.max(8, dica.y - 46) }}
             dangerouslySetInnerHTML={{ __html: dica.html }} />
      )}

      <div className="mapa-zoom">
        <button type="button" aria-label="Aproximar" onClick={() => zoom(base.current.w / 2, base.current.h / 2, 1.6)}><Plus size={15} aria-hidden /></button>
        <button type="button" aria-label="Afastar" onClick={() => zoom(base.current.w / 2, base.current.h / 2, 1 / 1.6)}><Minus size={15} aria-hidden /></button>
        <button type="button" aria-label="Enquadrar o Brasil" onClick={() => { vista.current = { k: 1, x: 0, y: 0 }; desenha(); }}><Maximize2 size={14} aria-hidden /></button>
      </div>

      <div className="mapa-escala mono">{carregando ? 'recalculando…' : status}</div>

      {dados && dados.semLocalizacao > 0 && (
        <div className="mapa-fora">
          <b className="mono">{fmt.format(dados.semLocalizacao)}</b> sem localização
          <span>{fmt.format(dados.soCidade)} só com o nome da cidade · {fmt.format(dados.semNada)} sem nada</span>
        </div>
      )}
      {!malhaPronta && <div className="mapa-carregando">carregando o mapa…</div>}
    </div>
  );
}
