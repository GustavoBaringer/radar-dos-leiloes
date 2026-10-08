import { useEffect, useState } from 'react';
import { type Visto, lerVistos, ouvirVistos } from '@/lib/vistos';
import { img, money } from '@/lib/format';

/** Lido só depois de montar: no servidor não há localStorage, e ler no render quebraria a hidratação. */
export function VistosRecentes({ aoAbrir }: { aoAbrir: (id: number) => void }) {
  const [vistos, setVistos] = useState<Visto[]>([]);
  useEffect(() => {
    setVistos(lerVistos());
    return ouvirVistos(() => setVistos(lerVistos()));
  }, []);
  if (!vistos.length) return null;
  return (
    <section className="faixa vistos" aria-labelledby="vistos-t">
      <h2 id="vistos-t">Continue de onde parou</h2>
      <p className="vistos-sub">Os últimos lotes que você abriu neste navegador.</p>
      <div className="vistos-linha">
        {vistos.slice(0, 3).map((v) => (
          <button key={v.id} type="button" className="visto" onClick={() => aoAbrir(v.id)}>
            <span className="visto-foto" style={v.foto ? { backgroundImage: `url("${img(v.foto, 240)}")` } : undefined} />
            <span className="visto-txt">
              <b>{v.titulo}</b>
              {v.lance != null && <span className="mono">{money(v.lance)}</span>}
              <small>{v.rotulo}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
