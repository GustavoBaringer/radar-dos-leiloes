import type { AccountSummary, Lot } from './types';

export interface FavoriteContext {
  known: Map<number, boolean>;
  pending: Map<number, { token: number; value: boolean; previous: boolean | undefined; delta: number }>;
  revisions: Map<number, number>;
  count: number | null;
}

export interface FavoriteReadStamp { ownerEpoch: number; owner: string | null; revisions: Map<number, number> }

export interface SummaryGeneration { request: number; identity: number; mutation: number }

export function summaryIsCurrent(started: SummaryGeneration, current: SummaryGeneration, pendingCount: number): boolean {
  return started.request === current.request && started.identity === current.identity &&
    started.mutation === current.mutation && pendingCount === 0;
}

export const emptyFavoriteContext = (): FavoriteContext => ({ known: new Map(), pending: new Map(), revisions: new Map(), count: null });

export function countsFromAccountSummary(summary: AccountSummary) {
  return {
    favoriteCount: Number.isFinite(summary.favoriteCount) ? summary.favoriteCount! : null,
    unreadAlertCount: Number.isFinite(summary.unreadAlertCount) ? summary.unreadAlertCount! : null,
  };
}

export function applyAccountSummary(state: FavoriteContext, summary: AccountSummary, currentIdentity: string | null) {
  const identity = summary.logado === false ? 'anon' : summary.conta?.id == null ? null : String(summary.conta.id);
  const changed = identity !== null && currentIdentity !== null && identity !== currentIdentity;
  if (state.pending.size > 0 && !changed) return { state, identity: currentIdentity, unreadAlertCount: null, accepted: false, changed: false };
  const base = changed ? emptyFavoriteContext() : state;
  const counts = countsFromAccountSummary(summary);
  return {
    state: { ...base, count: counts.favoriteCount },
    identity: identity ?? currentIdentity,
    unreadAlertCount: counts.unreadAlertCount,
    accepted: true,
    changed,
  };
}

/** Only IDs present in this response become known; pending clicks win over stale data. */
export function mergeFavoriteResponse(state: FavoriteContext, lots: Lot[], stamp?: FavoriteReadStamp, ownerEpoch = 0, owner: string | null = null): FavoriteContext {
  if (stamp && (stamp.ownerEpoch !== ownerEpoch || (stamp.owner !== null && owner !== stamp.owner))) return state;
  const known = new Map(state.known);
  for (const lot of lots) {
    if (stamp && (stamp.revisions.get(lot.id) ?? 0) !== (state.revisions.get(lot.id) ?? 0)) continue;
    if (state.pending.has(lot.id)) continue;
    if (typeof lot.favorited === 'boolean') known.set(lot.id, lot.favorited);
    else if ('favorited_em' in lot) known.set(lot.id, true);
  }
  return { ...state, known };
}

export function beginFavoriteMutation(state: FavoriteContext, id: number, value: boolean, token: number): FavoriteContext {
  if (state.pending.has(id)) return state;
  const previous = state.known.get(id);
  const pending = new Map(state.pending);
  const revisions = new Map(state.revisions);
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
  const delta = previous === undefined || state.count === null ? 0 : (value ? 1 : -1);
  pending.set(id, { token, value, previous, delta });
  const known = new Map(state.known);
  known.set(id, value);
  const count = state.count === null ? null : Math.max(0, state.count + delta);
  return { known, pending, revisions, count };
}

export function settleFavoriteMutation(state: FavoriteContext, id: number, token: number, ok: boolean): FavoriteContext {
  const pendingItem = state.pending.get(id);
  if (!pendingItem || pendingItem.token !== token) return state;
  const pending = new Map(state.pending);
  pending.delete(id);
  const revisions = new Map(state.revisions);
  revisions.set(id, (revisions.get(id) ?? 0) + 1);
  const known = new Map(state.known);
  let count = state.count;
  if (!ok) {
    if (pendingItem.previous === undefined) known.delete(id);
    else known.set(id, pendingItem.previous);
    if (count !== null) count = Math.max(0, count - pendingItem.delta);
  }
  return { ...state, known, pending, revisions, count };
}

export function resetFavoriteContext(): FavoriteContext {
  return emptyFavoriteContext();
}
