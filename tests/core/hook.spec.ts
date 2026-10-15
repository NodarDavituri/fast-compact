import { describe, expect, test } from 'bun:test';
import { meterLine, settingsOf } from '../../hooks/fast-compact.js';

describe('settingsOf', () => {
  test('provider: unset is openrouter; case does not matter; off is none', () => {
    expect(settingsOf({}).provider).toBe('openrouter');
    expect(settingsOf({ provider: 'TypeSafe' }).provider).toBe('typesafe');
    for (const value of ['none', 'None', 'NONE', 'off']) {
      expect(settingsOf({ provider: value })).toMatchObject({ provider: 'none', providerNote: undefined });
    }
  });

  test('provider: an unknown value sends nothing, and says why', () => {
    expect(settingsOf({ provider: 'openroute' })).toMatchObject({ provider: 'none', providerNote: 'unknown provider "openroute"' });
  });

  test('meter: prompt by default, case does not matter, unknown is the default', () => {
    expect(settingsOf({}).meter).toBe('prompt');
    expect(settingsOf({ meter: 'Both' }).meter).toBe('both');
    expect(settingsOf({ meter: 'OFF' }).meter).toBe('off');
    expect(settingsOf({ meter: 'sometimes' }).meter).toBe('prompt');
  });
});

describe('meterLine', () => {
  test('the share of the window, left out when it rounds to 0% or the window is unknown', () => {
    expect(meterLine({ chars: 0, tokens: 54_000, outputs: 9 }, 1_000_000)).toBe('/fc frees ~54k tokens (5%) · hide: /plugin configure fast-compact → meter');
    expect(meterLine({ chars: 0, tokens: 4_000, outputs: 2 }, 1_000_000)).toBe('/fc frees ~4.0k tokens · hide: /plugin configure fast-compact → meter');
    expect(meterLine({ chars: 0, tokens: 54_000, outputs: 9 })).not.toContain('%');
    expect(meterLine({ chars: 0, tokens: 54_000, outputs: 9 }, 1_000_000, false)).toBe('/fc frees ~54k tokens (5%)');
  });
});
