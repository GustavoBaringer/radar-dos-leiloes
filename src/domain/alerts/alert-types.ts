export interface Alerta {
  id: number;
  owner_id: number;
  created_at: string;
  label: string;
  q: string | null;
  filters: Record<string, any>;
  channels: string[];
  email: string | null;
}

export interface Disparo {
  alertId: number;
  /** Dono do alerta. O push precisa dele: sem isso o alerta de um usuário
   *  notificava o celular de todos os outros. */
  ownerId: number;
  label: string;
  channels: string[];
  email: string | null;
  lotId: number;
  title: string;
  lotUrl: string | null;
  bid: number | null;
  source: string;
}
