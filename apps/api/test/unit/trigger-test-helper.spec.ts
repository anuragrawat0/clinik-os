import { describe, expect, it } from 'vitest';
import { assertExpectedSqlState } from '../../src/core/db/trigger-test-helper';

describe('trigger test SQLSTATE assertions', () => {
  it('accepts a constraint rejection', () => {
    expect(() => assertExpectedSqlState({ code: '23514' }, ['23514'])).not.toThrow();
  });

  it('accepts insufficient privilege for a denied RLS write', () => {
    expect(() => assertExpectedSqlState({ code: '42501' }, ['42501'])).not.toThrow();
  });

  it('treats other class 42 errors as test failures', () => {
    expect(() =>
      assertExpectedSqlState({ code: '42703', message: 'undefined column' }, ['42703']),
    ).toThrow(/programming error/);
  });
});
