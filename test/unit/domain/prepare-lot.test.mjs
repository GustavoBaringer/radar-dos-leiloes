import { describe, expect, it } from '@jest/globals';
import { Lot } from '../../../dist/src/domain/lots/lot.js';
import { prepareLotForPersistence } from '../../../dist/src/domain/lots/prepare-lot.js';

const canonicalLot = (overrides = {}) => ({
  sourceId: 'fixture',
  externalId: 'fixture-1',
  titleRaw: 'Lote de veículo',
  closingModel: 'pregao_em_horario',
  sourceTz: 'America/Sao_Paulo',
  status: 'aberto',
  photos: [],
  ...overrides,
});

describe('prepareLotForPersistence', () => {
  it('rejects missing stable identity and delegates preparation for valid lots', () => {
    expect(() => new Lot(canonicalLot({ sourceId: '  ' }))).toThrow('Identidade do lote inválida.');
    const lot = new Lot(canonicalLot({ assetType: 'imovel', propertyType: 'casa' }));
    expect(lot.canonicalLot.sourceId).toBe('fixture');
    expect(lot.prepare().kind).toBe('accepted');
  });

  it('excludes collectibles even when the connector labels them as vehicles', () => {
    const result = prepareLotForPersistence(canonicalLot({
      assetType: 'veiculo',
      titleRaw: 'Volkswagen Golf MK2',
      raw: { descricao: 'Miniatura Hot Wheels escala 1:64' },
    }));
    expect(result).toEqual({ kind: 'out-of-scope', sourceId: 'fixture', externalId: 'fixture-1' });
  });

  it('prepares a vehicle with existing masking, normalization, and bid rules', () => {
    const result = prepareLotForPersistence(canonicalLot({
      titleRaw: 'VW/GOL CITY MB 2014/2015 PLACA ABC-1234',
      brand: 'VOLKSWAGEN',
      assetType: 'veiculo',
      vehicleType: 'carro',
      currentBid: 500,
      appraisal: 50_000,
      city: 'CUIABA',
      state: 'MT',
      color: 'BRANCA',
      photos: ['https://example.test/lot.jpg', 'https://example.test/no-image.png'],
    }));

    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.lot.assetType).toBe('veiculo');
    expect(result.lot.titleRaw).not.toContain('ABC-1234');
    expect(result.lot.plateMasked).toBe('A**-**34');
    expect(result.lot.bidSuspect).toBe(true);
    expect(result.lot.fields).toMatchObject({ city: 'Cuiaba', state: 'MT', color: 'branco', currentBid: 500 });
    expect(result.lot.fields.photos).toEqual(['https://example.test/lot.jpg']);
  });

  it('prepares an explicitly classified property without a vehicle type', () => {
    const result = prepareLotForPersistence(canonicalLot({
      titleRaw: 'CASA - JARDIM CENTRAL - CUIABA/MT',
      assetType: 'imovel',
      propertyType: 'casa',
      city: 'Cuiaba',
      state: 'MT',
      raw: { areaPrivativa: 120 },
    }));
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.lot).toMatchObject({ assetType: 'imovel', vehicleType: null, propertyType: 'casa', cityKey: 'CUIABA' });
    expect(result.lot.titleDisplay).toContain('Casa');
    expect(result.lot.titleDisplay).toContain('120 m²');
  });
});
