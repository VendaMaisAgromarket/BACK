import { brasiliaDateKey, startOfTodayInBrasilia } from '../brasiliaTime';

describe('brasiliaTime', () => {
  it('usa a data de Brasília mesmo quando em UTC já é o dia seguinte', () => {
    // 23:30 de 13/10 em Brasília = 02:30 de 14/10 em UTC
    const now = new Date('2026-10-14T02:30:00Z');
    expect(brasiliaDateKey(now)).toBe('2026-10-13');
    expect(startOfTodayInBrasilia(now).toISOString()).toBe('2026-10-13T03:00:00.000Z');
  });

  it('à meia-noite de Brasília já começa o novo dia', () => {
    const now = new Date('2026-10-14T03:00:00Z'); // 00:00 de 14/10 em Brasília
    expect(startOfTodayInBrasilia(now).toISOString()).toBe('2026-10-14T03:00:00.000Z');
  });

  it('às 23:59:59 de Brasília ainda é o mesmo dia', () => {
    const now = new Date('2026-10-14T02:59:59Z'); // 23:59:59 de 13/10 em Brasília
    expect(startOfTodayInBrasilia(now).toISOString()).toBe('2026-10-13T03:00:00.000Z');
  });
});
