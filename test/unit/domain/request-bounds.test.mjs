import { describe, expect, it } from '@jest/globals';
import { ValidateAlertInput } from '../../../dist/src/domain/search/request-bounds.js';

describe('ValidateAlertInput', () => {
  it('permite canal de e-mail sem campo email explícito para resolução autenticada', () => {
    const input = {
      label: 'Meu alerta de Civic',
      q: 'civic',
      channels: ['sino', 'email'],
    };
    const validated = ValidateAlertInput(input);
    expect(validated.channels).toEqual(['sino', 'email']);
    expect(validated.email).toBeUndefined();
    expect(validated.label).toBe('Meu alerta de Civic');
  });

  it('valida e preserva e-mail válido se explicitamente fornecido', () => {
    const input = {
      q: 'corolla',
      channels: ['sino', 'email'],
      email: 'usuario@exemplo.com.br',
    };
    const validated = ValidateAlertInput(input);
    expect(validated.channels).toEqual(['sino', 'email']);
    expect(validated.email).toBe('usuario@exemplo.com.br');
  });

  it('rejeita e-mail inválido quando explicitamente fornecido com formato incorreto', () => {
    expect(() => ValidateAlertInput({ q: 'fusca', channels: ['email'], email: 'invalido' }))
      .toThrow('E-mail do alerta inválido.');
    expect(() => ValidateAlertInput({ q: 'fusca', channels: ['email'], email: '   ' }))
      .toThrow('E-mail do alerta inválido.');
  });

  it('rejeita valor explicitamente null quando canal de e-mail está selecionado', () => {
    expect(() => ValidateAlertInput({ q: 'fusca', channels: ['email'], email: null }))
      .toThrow('Canal email exige endereço válido.');
  });

  it('permite edição parcial com canais atualizados e email omitido', () => {
    const edit = ValidateAlertInput({ channels: ['sino', 'email'] }, { edit: true });
    expect(edit.channels).toEqual(['sino', 'email']);
    expect(edit.email).toBeUndefined();
  });
});
