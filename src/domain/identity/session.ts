export type Papel = 'admin' | 'comum';

export interface Sessao {
  valido: boolean;
  papel: Papel | null;
  sub: string | null;
  /** Momento do login. É o que o teto absoluto mede, e por isso não se renova. */
  nasceu: number;
  /** Fim da janela de ociosidade deste cookie. */
  expiraEm: number;
  /** Por que caiu, quando caiu. A tela de login mostra o motivo em vez de um formulário mudo. */
  motivo: 'ok' | 'ausente' | 'malformado' | 'ocioso' | 'expirado' | 'assinatura';
}
