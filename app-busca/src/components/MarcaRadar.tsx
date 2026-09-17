/**
 * A assinatura visual: o radar que varre.
 *
 * Portado pixel a pixel do `.marca-radar` da landing — malha, cone em
 * conic-gradient girando e o ponto de sinal com halo. É o elemento que faz a
 * busca e a landing serem reconhecidamente o mesmo produto, então ele não é
 * reinterpretado aqui; é o mesmo desenho.
 */
export function MarcaRadar({ tamanho = 36 }: { tamanho?: number }) {
  return (
    <span
      className="marca-radar"
      style={{ width: tamanho, height: tamanho, borderRadius: tamanho / 3 }}
      aria-hidden
    >
      <i className="malha" />
      <span className="cone sweep" />
      <span className="ponto" />
    </span>
  );
}
