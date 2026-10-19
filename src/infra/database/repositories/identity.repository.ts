import { query } from '../query.js';
import type { Papel } from '../../../infra/auth/session.js';

export class IdentityRepository {
  constructor(private readonly queryFn: typeof query = query) {}

  async garantirUsuario(dados: { sub: string; email?: string | null; nome?: string | null; papel: Papel }) {
    const [u] = await this.queryFn<{ id: string; sub: string; email: string | null; nome: string | null; papel: Papel }>(
      `INSERT INTO users (sub, email, nome, papel, visto_em)
     VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4, now())
     ON CONFLICT (sub) WHERE sub IS NOT NULL
     DO UPDATE SET email = COALESCE(NULLIF(EXCLUDED.email,''), users.email),
                   nome  = COALESCE(NULLIF(EXCLUDED.nome,''),  users.nome),
                   papel = EXCLUDED.papel,
                   visto_em = now()
     RETURNING id, sub, email, nome, papel`,
      [dados.sub, dados.email ?? '', dados.nome ?? '', dados.papel],
    );
    return u;
  }

  async identidadePorSub(sub: string) {
    const [u] = await this.queryFn<{ id: string; email: string | null; nome: string | null; papel: Papel }>(
      `SELECT id, email, nome, papel FROM users WHERE sub = $1`,
      [sub],
    );
    return u;
  }

  async usuarioDoPortao(papel: Papel) {
    const [u] = await this.queryFn<{ id: string; nome: string | null }>(
      `SELECT id, nome FROM users WHERE papel = $1 AND sub IS NULL ORDER BY id LIMIT 1`,
      [papel],
    );
    return u;
  }
}
