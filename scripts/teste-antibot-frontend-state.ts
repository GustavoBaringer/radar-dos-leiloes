import assert from 'node:assert/strict';
import {
  applyAccountSummary, beginFavoriteMutation, countsFromAccountSummary, emptyFavoriteContext,
  mergeFavoriteResponse, resetFavoriteContext, settleFavoriteMutation, summaryIsCurrent, type FavoriteContext,
} from '../app-busca/src/lib/favorite-context.js';
import type { Lot } from '../app-busca/src/lib/types.js';

const lot = (id: number, favorited?: boolean) => ({ id, favorited } as Lot);
let state = emptyFavoriteContext();
const explicitContext: FavoriteContext = { known: new Map(), pending: new Map(), revisions: new Map(), count: null };
assert.equal(explicitContext.count, null);
state = { ...state, count: 31 };
state = mergeFavoriteResponse(state, Array.from({ length: 24 }, (_, i) => lot(i + 1, i === 0)));
state = mergeFavoriteResponse(state, [lot(25, true), lot(26, false)]);
assert.equal(state.count, 31, 'page merges never infer global count');
assert.equal(state.known.get(25), true, 'second page adds true membership');
assert.equal(state.known.get(26), false, 'response removes false membership');
assert.equal(state.known.has(100), false, 'missing IDs remain unknown');
assert.deepEqual(countsFromAccountSummary({ favoriteCount: 31, unreadAlertCount: 47 }),
  { favoriteCount: 31, unreadAlertCount: 47 }, 'global summary is independent of the 24-row page');

state = beginFavoriteMutation(state, 25, false, 3);
const stale = mergeFavoriteResponse(state, [lot(25, true)]);
assert.equal(stale.known.get(25), false, 'pending mutation wins over stale response');
state = settleFavoriteMutation(stale, 25, 3, false);
assert.equal(state.known.get(25), true, 'rollback restores prior true membership');
state = beginFavoriteMutation(state, 26, true, 1);
assert.equal(state.count, 32, 'known-status mutation optimistically adjusts exact count');
state = settleFavoriteMutation(state, 26, 1, false);
assert.equal(state.known.get(26), false, 'failed mutation restores previous membership');
assert.equal(state.count, 31, 'failed mutation restores exact previous count');

state = beginFavoriteMutation(state, 200, true, 2);
assert.equal(state.count, 31, 'unknown prior membership never guesses count delta');
state = settleFavoriteMutation(state, 200, 2, false);
assert.equal(state.known.has(200), false, 'rollback restores unknown status');
assert.equal(resetFavoriteContext().known.size, 0, 'account change clears private membership cache');

let pair: ReturnType<typeof emptyFavoriteContext> = { ...emptyFavoriteContext(), count: 10, known: new Map([[1, false], [2, false]]) };
pair = beginFavoriteMutation(pair, 1, true, 11);
pair = beginFavoriteMutation(pair, 2, true, 12);
assert.equal(pair.count, 12);
pair = settleFavoriteMutation(pair, 1, 11, false);
assert.equal(pair.count, 11, 'rolling back A subtracts only A while B is pending');
assert.equal(pair.pending.has(2), true);
pair = settleFavoriteMutation(pair, 2, 12, true);
assert.equal(pair.count, 11);

pair = { ...emptyFavoriteContext(), count: 10, known: new Map([[1, false], [2, false]]) };
pair = beginFavoriteMutation(pair, 1, true, 21);
pair = beginFavoriteMutation(pair, 2, true, 22);
pair = settleFavoriteMutation(pair, 2, 22, false);
assert.equal(pair.count, 11, 'B rollback preserves A optimistic delta');
pair = settleFavoriteMutation(pair, 1, 21, true);
assert.equal(pair.count, 11, 'reverse completion order is stable');

pair = { ...emptyFavoriteContext(), count: 10, known: new Map([[1, true], [2, false]]) };
pair = beginFavoriteMutation(pair, 1, false, 41);
pair = beginFavoriteMutation(pair, 2, true, 42);
assert.equal(pair.count, 10, 'opposite mutations apply independent deltas');
pair = settleFavoriteMutation(pair, 1, 41, false);
assert.equal(pair.count, 11, 'opposite rollback preserves unrelated add');
pair = settleFavoriteMutation(pair, 2, 42, true);
assert.equal(pair.count, 11);

const pendingSummary = beginFavoriteMutation({ ...emptyFavoriteContext(), count: 10, known: new Map([[1, false]]) }, 1, true, 31);
const oldGeneration = { request: 4, identity: 2, mutation: 0 };
const currentGeneration = { request: 4, identity: 2, mutation: 1 };
assert.equal(summaryIsCurrent(oldGeneration, currentGeneration, pendingSummary.pending.size), false,
  'summary started before a mutation cannot replace its optimistic count');
assert.equal(applyAccountSummary(pendingSummary, { favoriteCount: 10 }, 'owner-a').accepted, false,
  'same-account summary waits for pending mutation settlement');
const switched = applyAccountSummary(pendingSummary, {
  conta: { id: 9 }, favoriteCount: 4, unreadAlertCount: 37,
}, 'owner-a');
assert.equal(switched.changed, true);
assert.equal(switched.state.pending.size, 0, 'owner switch clears pending private mutations');
assert.equal(switched.state.count, 4);
assert.equal(switched.unreadAlertCount, 37, 'summary count is not limited to hit page size');
assert.equal(summaryIsCurrent({ request: 3, identity: 1, mutation: 0 }, currentGeneration, 0), false,
  'late previous-owner summary is rejected by generation');
let race = { ...emptyFavoriteContext(), known: new Map([[1, true], [2, false]]) };
const readStamp = { ownerEpoch: 0, owner: 'owner-a', revisions: new Map(race.revisions) };
race = beginFavoriteMutation(race, 1, false, 51);
race = settleFavoriteMutation(race, 1, 51, true);
race = mergeFavoriteResponse(race, [lot(1, true)], readStamp, 0, 'owner-a');
assert.equal(race.known.get(1), false, 'successful DELETE remains false after pre-mutation GET arrives');
race = mergeFavoriteResponse(race, [lot(2, true)], readStamp, 0, 'owner-a');
assert.equal(race.known.get(2), true, 'unrelated IDs from the same old read still merge');
let inverse = { ...emptyFavoriteContext(), known: new Map([[1, false]]) };
const inverseStamp = { ownerEpoch: 0, owner: 'owner-a', revisions: new Map(inverse.revisions) };
inverse = beginFavoriteMutation(inverse, 1, true, 52);
inverse = settleFavoriteMutation(inverse, 1, 52, true);
inverse = mergeFavoriteResponse(inverse, [lot(1, false)], inverseStamp, 0, 'owner-a');
assert.equal(inverse.known.get(1), true, 'successful add survives a pre-mutation false response');
let rollback = { ...emptyFavoriteContext(), known: new Map([[1, true]]) };
const rollbackStamp = { ownerEpoch: 0, owner: 'owner-a', revisions: new Map(rollback.revisions) };
rollback = beginFavoriteMutation(rollback, 1, false, 53);
rollback = settleFavoriteMutation(rollback, 1, 53, false);
rollback = mergeFavoriteResponse(rollback, [lot(1, false)], rollbackStamp, 0, 'owner-a');
assert.equal(rollback.known.get(1), true, 'failed delete rollback is not overwritten by in-flight response');
let pendingDelete = { ...emptyFavoriteContext(), known: new Map([[1, true]]) };
pendingDelete = beginFavoriteMutation(pendingDelete, 1, false, 54);
const duringDelete = { ownerEpoch: 0, owner: 'owner-a', revisions: new Map(pendingDelete.revisions) };
pendingDelete = settleFavoriteMutation(pendingDelete, 1, 54, true);
pendingDelete = mergeFavoriteResponse(pendingDelete, [lot(1, true)], duringDelete, 0, 'owner-a');
assert.equal(pendingDelete.known.get(1), false, 'read begun during DELETE is rejected after commit');
let pendingAdd = { ...emptyFavoriteContext(), known: new Map([[1, false]]) };
pendingAdd = beginFavoriteMutation(pendingAdd, 1, true, 55);
const duringAdd = { ownerEpoch: 0, owner: 'owner-a', revisions: new Map(pendingAdd.revisions) };
pendingAdd = settleFavoriteMutation(pendingAdd, 1, 55, true);
pendingAdd = mergeFavoriteResponse(pendingAdd, [lot(1, false)], duringAdd, 0, 'owner-a');
assert.equal(pendingAdd.known.get(1), true, 'read begun during ADD is rejected after commit');
let pendingRollback = { ...emptyFavoriteContext(), known: new Map([[1, true]]) };
pendingRollback = beginFavoriteMutation(pendingRollback, 1, false, 56);
const duringRollback = { ownerEpoch: 0, owner: 'owner-a', revisions: new Map(pendingRollback.revisions) };
pendingRollback = settleFavoriteMutation(pendingRollback, 1, 56, false);
pendingRollback = mergeFavoriteResponse(pendingRollback, [lot(1, false)], duringRollback, 0, 'owner-a');
assert.equal(pendingRollback.known.get(1), true, 'read begun during failed mutation is rejected after rollback');
pendingRollback = mergeFavoriteResponse(pendingRollback, [lot(2, true)], duringRollback, 0, 'owner-a');
assert.equal(pendingRollback.known.get(2), true, 'settle revision does not block unrelated IDs');
const ownerStamp = { ownerEpoch: 0, owner: 'owner-a', revisions: new Map() };
const ownerSwitched = mergeFavoriteResponse(emptyFavoriteContext(), [lot(3, true)], ownerStamp, 1, 'owner-b');
assert.equal(ownerSwitched.known.has(3), false, 'previous owner read is rejected after account switch');
assert.deepEqual(countsFromAccountSummary({}), { favoriteCount: null, unreadAlertCount: null },
  'legacy summary fields remain unknown');
console.log('favorite context state: ok');
