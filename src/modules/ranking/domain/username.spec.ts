import { describe, expect, it } from 'vitest';
import { canonicalUsername, generateUsername, normalizeForCheck, usernameChangeAvailableAt, usernameProblem } from './username';

describe('username', () => {
  it('generates valid adjective_animal_NNNN names', () => {
    for (let i = 0; i < 200; i++) {
      const name = generateUsername();
      expect(name).toMatch(/^[a-z]+_[a-z]+_\d{4}$/);
      expect(usernameProblem(name)).toBeNull();
    }
  });

  it('enforces the format', () => {
    expect(usernameProblem('ab')).toBe('USERNAME_INVALID');
    expect(usernameProblem('1abc')).toBe('USERNAME_INVALID');
    expect(usernameProblem('a..b')).toBe('USERNAME_INVALID');
    expect(usernameProblem('a'.repeat(21))).toBe('USERNAME_INVALID');
    expect(usernameProblem('héllo')).toBe('USERNAME_INVALID');
    expect(usernameProblem(canonicalUsername(' Alan.Lee_7 '))).toBeNull();
  });

  it('blocks reserved names and profanity through separators and leetspeak', () => {
    expect(normalizeForCheck('4dm1n_x')).toBe('adminx');
    expect(usernameProblem('syll')).toBe('USERNAME_NOT_ALLOWED');
    expect(usernameProblem('s_y_l_l')).toBe('USERNAME_NOT_ALLOWED');
    expect(usernameProblem('the_4dm1n')).toBe('USERNAME_NOT_ALLOWED');
    expect(usernameProblem('sh1t.happens')).toBe('USERNAME_NOT_ALLOWED');
    expect(usernameProblem('hi_dm')).toBe('USERNAME_NOT_ALLOWED');
    expect(usernameProblem('syllable_fan')).toBeNull();
    expect(usernameProblem('random_long')).toBeNull();
  });

  it('frees a generated name once, then waits the change window', () => {
    const now = new Date('2026-11-12T00:00:00Z');
    expect(usernameChangeAvailableAt({ usernameGenerated: true, usernameChangedAt: null }, now)).toBeNull();
    expect(usernameChangeAvailableAt({ usernameGenerated: false, usernameChangedAt: new Date('2026-11-10T00:00:00Z') }, now))
      .toEqual(new Date('2026-12-10T00:00:00Z'));
    expect(usernameChangeAvailableAt({ usernameGenerated: false, usernameChangedAt: new Date('2026-10-01T00:00:00Z') }, now)).toBeNull();
  });
});
