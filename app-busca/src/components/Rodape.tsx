import { MarcaRadar } from './MarcaRadar';

/** Mesmo rodapé da landing, com os links que fazem sentido dentro do app. */
export function Rodape() {
  return (
    <footer className="rodape">
      <div className="faixa rodape-grade">
        <div>
          <a className="logo" href="/">
            <MarcaRadar tamanho={30} />
            <span className="logo-txt">Radar de Leilões</span>
          </a>
          <p className="rodape-pitch">
            Veículos e imóveis de leilão de todo o Brasil, num índice só, com lance, prazo e link
            direto para o site do leiloeiro.
          </p>
        </div>
        <div>
          <h4>Buscar</h4>
          <ul>
            <li><a href="/busca?tipo=veiculo">Veículos</a></li>
            <li><a href="/busca?tipo=imovel">Imóveis</a></li>
            <li><a href="/alertas">Meus alertas</a></li>
          </ul>
        </div>
        <div>
          <h4>Produto</h4>
          <ul>
            <li><a href="/#confianca">Como funciona</a></li>
            <li><a href="/#leiloeiros">Leiloeiros</a></li>
            <li><a href="/#cobertura">Cobertura</a></li>
          </ul>
        </div>
      </div>
      <div className="faixa rodape-fim">
        O Radar de Leilões é um índice de anúncios públicos. Não somos leiloeiros e não
        intermediamos lance: cada lote leva ao site do leiloeiro responsável. Lance e avaliação
        são os publicados pela fonte, e avaliação não é preço de venda.
      </div>
    </footer>
  );
}
