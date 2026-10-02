import type { ReactNode } from 'react';
import { Bike, Car, House, Truck } from 'lucide-react';
import type { Facets } from '@/lib/types';
import type { EstadoBusca } from '@/lib/filtros';
import { img } from '@/lib/format';

export const CATEGORIAS: Array<{ id: string; nome: string; ico: ReactNode }> = [
  { id: 'carro', nome: 'Carros', ico: <Car aria-hidden /> },
  { id: 'suv', nome: 'SUVs', ico: <Car aria-hidden /> },
  { id: 'moto', nome: 'Motos', ico: <Bike aria-hidden /> },
  { id: 'picape', nome: 'Picapes', ico: <Truck aria-hidden /> },
  { id: 'caminhao', nome: 'Caminhões', ico: <Truck aria-hidden /> },
  { id: 'imovel', nome: 'Imóveis', ico: <House aria-hidden /> },
];

interface Props {
  estado: EstadoBusca;
  facetas: Facets | null;
  /** Uma foto real por categoria, guardada da primeira vez que um lote dela apareceu. */
  fotos: Record<string, string>;
  aoEscolher: (id: string) => void;
}

export function Categorias({ estado, facetas, fotos, aoEscolher }: Props) {
  const conta = (id: string) =>
    (id === 'imovel' ? facetas?.assetTypes : facetas?.vehicleTypes)?.find((r) => r.value === id)?.count;
  const ativa = (id: string) =>
    id === 'imovel' ? estado.assetType === 'imovel' : estado.multi.vehicleType.length === 1 && estado.multi.vehicleType[0] === id;

  return (
    <div className="cats" role="group" aria-label="Categorias">
      {CATEGORIAS.map((c) => {
        const n = conta(c.id);
        return (
          <button
            key={c.id}
            type="button"
            className={`cat${fotos[c.id] ? '' : ' sem-foto'}`}
            aria-pressed={ativa(c.id)}
            onClick={() => aoEscolher(c.id)}
            style={fotos[c.id] ? { backgroundImage: `url("${img(fotos[c.id], 480)}")` } : undefined}
          >
            <span className="cat-ico">{c.ico}</span>
            <span className="cat-txt">
              <b>{c.nome}</b>
              <span className="mono">{n != null ? `${n.toLocaleString('pt-BR')} lotes` : '—'}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
