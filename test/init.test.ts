import { describe, it, expect } from 'vitest';
import { buildTableConfig, parseSeatSpec } from '../src/init.js';
import type { TableConfig } from '../src/protocol.js';

const seats = [
  { seat: 'alice', owner: 'tao', publicKey: 'PUB-A' },
  { seat: 'bob', owner: 'jenny', publicKey: 'PUB-B' },
];

const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'OK'; };

describe('convene init', () => {
  it('builds a broadcast table from owner key files', () => {
    const cfg = buildTableConfig({ id: 'main', topic: 'two people, two machines', seats });
    expect(cfg.id).toBe('main');
    expect(cfg.topology).toMatchObject({ kind: 'broadcast', order: ['alice', 'bob'], rounds: 3 });
    expect(cfg.owners).toEqual({ tao: { public_key: 'PUB-A' }, jenny: { public_key: 'PUB-B' } });
    // The first seat decides unless told otherwise.
    expect(cfg.floor?.decision_by).toEqual(['alice']);
    expect(cfg.termination.any).toEqual(['rounds_exhausted']);
  });

  it('lets one owner hold several seats without duplicating the owner entry', () => {
    const cfg = buildTableConfig({
      id: 't', topic: 'x',
      seats: [...seats, { seat: 'bob2', owner: 'jenny', publicKey: 'PUB-B' }],
    });
    expect(Object.keys(cfg.owners).sort()).toEqual(['jenny', 'tao']);
    expect(cfg.topology.order).toEqual(['alice', 'bob', 'bob2']);
  });

  it('refuses the same seat twice, or one owner used with two different keys', () => {
    expect(codeOf(() => buildTableConfig({ id: 't', topic: 'x', seats: [seats[0], seats[0]] }))).toBe('E_CONFIG');
    expect(codeOf(() => buildTableConfig({
      id: 't', topic: 'x',
      seats: [seats[0], { seat: 'b', owner: 'tao', publicKey: 'OTHER' }],
    }))).toBe('E_CONFIG');
  });

  it('carries a token budget when one is given, and honours an explicit decider', () => {
    const cfg = buildTableConfig({ id: 't', topic: 'x', seats, budgetTokens: 50000, decisionBy: 'bob', rounds: 5 });
    expect(cfg.termination.any).toContainEqual({ budget_tokens: 50000 });
    expect(cfg.floor?.decision_by).toEqual(['bob']);
    expect(cfg.topology.rounds).toBe(5);
  });

  it('keeps the result valid for Table Core: it can be checked against the schema', async () => {
    const { check } = await import('../src/schema.js');
    const cfg: TableConfig = buildTableConfig({ id: 'valid', topic: 'checks out', seats });
    expect(() => check('table-config', cfg)).not.toThrow();
  });

  it('parses <seat>:<key file>, including paths that contain a colon', () => {
    expect(parseSeatSpec('alice:alice.owner.json')).toEqual({ seat: 'alice', keyFile: 'alice.owner.json' });
    expect(parseSeatSpec('bob:/home/x/a:b.owner.json')).toEqual({ seat: 'bob', keyFile: '/home/x/a:b.owner.json' });
    expect(() => parseSeatSpec('nocolon')).toThrow(/name/);
  });
});
