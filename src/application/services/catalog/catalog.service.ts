import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Identidade } from '../../../core/identidade.js';
import { createAccountContext } from '../../../core/account-context.js';
import type { PublicLot } from '../../../domain/lots/public-dto.js';
import { toPublicLot } from '../../../domain/lots/public-dto.js';
import { parseQuery } from '../../../domain/lots/normalize.js';
import type { SearchParams } from '../../../domain/search/search-params.js';
import { CATALOG_QUERY, type CatalogQuery, CatalogRepository } from '../../../infra/database/repositories/catalog.repository.js';

export type CatalogActor = Pick<Identidade, 'userId' | 'papel'>;

export class CatalogServiceError extends Error {
  constructor(readonly statusCode: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.name = 'CatalogServiceError';
  }
}

function requireActor(actor: CatalogActor): CatalogActor {
  if (!actor || !Number.isSafeInteger(actor.userId) || actor.userId <= 0) {
    throw new CatalogServiceError(401, 'Autenticação necessária.');
  }
  if (actor.papel !== 'admin' && actor.papel !== 'comum') {
    throw new CatalogServiceError(401, 'Autenticação necessária.');
  }
  return actor;
}

@Injectable()
export class CatalogService {
  private readonly accountContext: ReturnType<typeof createAccountContext>;

  constructor(
    private readonly repository: CatalogRepository,
    @Inject(CATALOG_QUERY) query: CatalogQuery,
  ) {
    this.accountContext = createAccountContext(query);
  }

  async home(actorInput: CatalogActor) {
    const actor = requireActor(actorInput);
    const data = await this.repository.home();
    return {
      ...data,
      recentes: await this.decorate(actor, data.recentes.map((row: unknown) => toPublicLot(row))),
    };
  }

  async vitrine() {
    const data = await this.repository.vitrine();
    const categories = [
      { id: 'carro', label: 'Carros', icone: 'carro', query: 'vehicleType=carro' },
      { id: 'suv', label: 'SUVs', icone: 'carro', query: 'vehicleType=suv' },
      { id: 'moto', label: 'Motos', icone: 'moto', query: 'vehicleType=moto' },
      { id: 'picape', label: 'Picapes', icone: 'caminhao', query: 'vehicleType=picape' },
      { id: 'caminhao', label: 'Caminhões', icone: 'caminhao', query: 'vehicleType=caminhao' },
      { id: 'imovel', label: 'Imóveis', icone: 'casa', query: 'assetType=imovel' },
    ];
    const c = data.categorias;
    const emQuanto = (fim: string | Date) => {
      const dif = new Date(fim).getTime() - Date.now();
      const min = Math.max(0, Math.round(dif / 60_000));
      if (min < 1) return 'encerrando agora';
      if (min < 60) return `encerra em ${min} min`;
      const h = Math.floor(min / 60);
      return h < 24 ? `encerra em ${h}h ${min % 60}min` : `encerra em ${Math.floor(h / 24)}d`;
    };
    return {
      ...data.agregados,
      ufs: data.ufs,
      leiloeiros: data.leiloeiros,
      recentes: data.recentes.map((row) => toPublicLot(row)),
      heroes: data.heroes.map((row) => toPublicLot(row)),
      categorias: categories.map((category, i) => ({
        ...category,
        total: c[`c${i}`] ?? 0,
        foto: data.fotosCat.find((photo) => photo.cat === category.id)?.foto ?? null,
      })),
      encerrando: data.encerrando.map((lot) => ({ ...lot, quando: emQuanto(lot.auction_end_utc) })),
      porHora: data.porHora.map((row) => row.total),
    };
  }

  async homeLeiloeiro(nome: string, actorInput: CatalogActor) {
    const actor = requireActor(actorInput);
    const name = nome.trim();
    if (!name) throw new CatalogServiceError(400, 'informe o leiloeiro');
    const rows = await this.repository.homeLeiloeiro(name);
    return this.decorate(actor, rows.map((row) => toPublicLot(row)));
  }

  async search(input: SearchParams, actorInput: CatalogActor) {
    const actor = requireActor(actorInput);
    const result = await this.repository.search(input);
    return { ...result, items: await this.decorate(actor, result.items) };
  }

  searchMap(input: SearchParams, actorInput: CatalogActor) {
    requireActor(actorInput);
    return this.repository.searchMap(input);
  }

  async detail(id: number, actorInput: CatalogActor) {
    const actor = requireActor(actorInput);
    if (!Number.isSafeInteger(id) || id <= 0) throw new CatalogServiceError(400, 'id inválido');
    const lot = await this.repository.detail(id, actor.papel === 'admin');
    if (!lot) throw new CatalogServiceError(404, 'lote não encontrado');
    return (await this.decorate(actor, [lot]))[0];
  }

  malha(tipo: string, dataDir: string, actorInput: CatalogActor): Buffer {
    requireActor(actorInput);
    if (tipo !== 'uf' && tipo !== 'municipio') throw new CatalogServiceError(404, 'malha desconhecida');
    const file = join(dataDir, 'geo', `${tipo}.json`);
    if (!existsSync(file)) throw new CatalogServiceError(404, 'malha ausente');
    return readFileSync(file);
  }

  stats(actorInput: CatalogActor) {
    this.requireAdmin(actorInput);
    return this.repository.stats();
  }

  sources(actorInput: CatalogActor) {
    this.requireAdmin(actorInput);
    return this.repository.sources();
  }

  brands(actorInput: CatalogActor) {
    requireActor(actorInput);
    return this.repository.brands();
  }

  explain(q: string | undefined, actorInput: CatalogActor) {
    requireActor(actorInput);
    return parseQuery(q ?? '');
  }

  private decorate(actor: CatalogActor, lots: readonly PublicLot[]) {
    return this.accountContext.decorateLots(actor.userId, lots);
  }

  private requireAdmin(actorInput: CatalogActor) {
    const actor = requireActor(actorInput);
    if (actor.papel !== 'admin') throw new CatalogServiceError(403, 'requer administrador');
    return actor;
  }
}
