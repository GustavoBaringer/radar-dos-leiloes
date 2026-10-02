import { Bell, Search, Tag } from 'lucide-react';

const PASSOS = [
  { ico: <Search aria-hidden />, titulo: 'Uma busca, várias fontes', texto: 'Copart, Superbid, Caixa, Leilo, vLance e outras plataformas no mesmo formato de preço e prazo.' },
  { ico: <Tag aria-hidden />, titulo: 'Preço sem pegadinha', texto: 'Lance inicial, atual e mínimo têm nomes diferentes, e a avaliação aparece como o que é: um valor publicado pela fonte.' },
  { ico: <Bell aria-hidden />, titulo: 'Alerta antes do concorrente', texto: 'Salve qualquer busca e receba um aviso a cada lote novo que combine com ela.' },
];

export function ComoFunciona() {
  return (
    <section className="como" aria-labelledby="como-t">
      <div className="faixa">
        <h2 id="como-t">Como o Radar trabalha para você</h2>
        <div className="como-passos">
          {PASSOS.map((p) => (
            <div key={p.titulo} className="como-passo">
              <span className="como-ico">{p.ico}</span>
              <h3>{p.titulo}</h3>
              <p>{p.texto}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
