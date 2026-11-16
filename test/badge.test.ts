// Badge (design section 5.2): visual identity signed into the card, so it cannot be impersonated
// by a client, and it can only change when the owner signs again.
import { describe, it, expect } from 'vitest';
import { Table } from '../src/table.js';
import { cfg, seat, owners } from './helpers.js';
import { badgeFor, renderPrefix, DEFAULT_BADGE_COLOR } from '../src/client.js';
import type { CapabilityCard } from '../src/protocol.js';

const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'OK'; };

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
const badged: CapabilityCard = { bot: 'bot', capabilities: [], badge: { svg: SVG, color: '#FF8800' } };

type SeatInPrefix = { seat: string; badge: { svg?: string; color?: string } | null };

describe('capability-card.badge', () => {
  it('travels with the card into the projection prefix, and renders with its colour and an svg marker', () => {
    const t = new Table(cfg('bd', { kind: 'broadcast', order: ['a'] }));
    seat(t, 'a', 'tao', badged);
    const p = t.projection('a', 0);
    const s = (p.prefix.seats as SeatInPrefix[])[0];
    expect(s.badge).toMatchObject({ color: '#FF8800' });
    expect(s.badge!.svg).toContain('<svg');
    expect(renderPrefix(p)).toMatch(/badge: #FF8800\+svg/);
    // The badge is part of the seat record everyone sees, not a per-seat secret.
    expect(JSON.stringify(p.prefix)).toContain('#FF8800');
  });

  it('is null for a seat that never sent one; a renderer falls back to the initial and the default colour', () => {
    const t = new Table(cfg('bd2', { kind: 'broadcast', order: ['a'] }));
    seat(t, 'a', 'tao');
    const s = (t.projection('a', 0).prefix.seats as SeatInPrefix[])[0];
    expect(s.badge).toBeNull();
    expect(renderPrefix(t.projection('a', 0))).not.toMatch(/badge:/);

    expect(badgeFor({ seat: 'alice' })).toEqual({ svg: undefined, color: DEFAULT_BADGE_COLOR, initial: 'A' });
    expect(badgeFor({ seat: 'bob', badge: { color: '#123456' } })).toEqual({ svg: undefined, color: '#123456', initial: 'B' });
    expect(badgeFor({ seat: 'carol', badge: { svg: SVG } }).svg).toBe(SVG);
  });

  it('rejects a colour that is not a six-digit hex value', () => {
    const t = new Table(cfg('bd3', { kind: 'broadcast', order: ['a'] }));
    expect(codeOf(() => seat(t, 'a', 'tao', { bot: 'x', capabilities: [], badge: { color: 'blue' } }))).toBe('E_SCHEMA');
    expect(codeOf(() => seat(t, 'a', 'tao', { bot: 'x', capabilities: [], badge: { color: '#F80' } }))).toBe('E_SCHEMA');
  });

  it('cannot be swapped after signing: a card that differs from the signed payload fails verification', () => {
    const t = new Table(cfg('bd4', { kind: 'broadcast', order: ['a', 'b'] }));
    seat(t, 'a', 'tao', badged);
    // jenny signs a join for a card without a badge, then the request is rewritten to carry one.
    const signed = owners.jenny.signJoin('bd4', { seat: 'b', kind: 'bot', card: { bot: 'x', capabilities: [] } });
    expect(codeOf(() => t.join({ ...signed, card: badged } as never))).toBe('E_BAD_SIGNATURE');
  });
});
