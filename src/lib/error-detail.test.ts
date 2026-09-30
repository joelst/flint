import { describe, it, expect } from 'vitest';
import { formatErrorDetail, formatUncaughtError, MAX_ERROR_DETAIL } from './error-detail';

describe('formatErrorDetail', () => {
  it('formats an ordinary Error as name and message', () => {
    expect(formatErrorDetail(new TypeError('bad input'))).toBe('TypeError: bad input');
  });

  it('keeps the name when an Error carries no message', () => {
    expect(formatErrorDetail(new RangeError(''))).toBe('RangeError');
  });

  it('falls back to Error when the name was blanked', () => {
    const err = new Error('boom');
    err.name = '';
    expect(formatErrorDetail(err)).toBe('Error: boom');
  });

  it('describes null and undefined without inventing a cause', () => {
    expect(formatErrorDetail(null)).toBe('unknown error');
    expect(formatErrorDetail(undefined)).toBe('unknown error');
  });

  it('uses a plain object message, the common rejected-promise shape', () => {
    expect(formatErrorDetail({ message: 'sidecar refused' })).toBe('sidecar refused');
  });

  it('formats primitives that were thrown directly', () => {
    expect(formatErrorDetail('just a string')).toBe('just a string');
    expect(formatErrorDetail(42)).toBe('42');
    expect(formatErrorDetail(false)).toBe('false');
  });

  it('truncates a long message instead of flooding the banner', () => {
    const detail = formatErrorDetail(new Error('x'.repeat(1000)));
    expect(detail.length).toBe(MAX_ERROR_DETAIL);
    expect(detail.endsWith('…')).toBe(true);
  });

  // Each of the following makes `String(value)` throw. The formatter runs on the error path,
  // so a throw here would replace the message the user needs with a blank view.
  it('survives an object with no prototype', () => {
    expect(formatErrorDetail(Object.create(null))).toBe('an error that could not be displayed');
  });

  it('survives a throwing toString', () => {
    const hostile = { toString() { throw new Error('nope'); } };
    expect(formatErrorDetail(hostile)).toBe('an error that could not be displayed');
  });

  it('survives a throwing message getter', () => {
    const hostile = { get message(): string { throw new Error('nope'); } };
    expect(formatErrorDetail(hostile)).toBe('an error that could not be displayed');
  });

  it('survives an Error whose message getter throws', () => {
    const err = new Error('start');
    Object.defineProperty(err, 'message', { get() { throw new Error('nope'); } });
    expect(formatErrorDetail(err)).toBe('an error that could not be displayed');
  });

  it('survives a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable({ message: 'gone' }, {});
    revoke();
    expect(formatErrorDetail(proxy)).toBe('an error that could not be displayed');
  });

  it('formats a thrown symbol, which throws on implicit conversion', () => {
    expect(formatErrorDetail(Symbol('tag'))).toBe('Symbol(tag)');
  });

  it('never returns an empty string', () => {
    for (const value of ['', 0, Number.NaN, [], {}]) {
      expect(formatErrorDetail(value).length).toBeGreaterThan(0);
    }
  });

  it('treats a whitespace-only detail as absent rather than rendering a blank line', () => {
    // A blank banner is worse than a generic one: it reads as a rendering bug of its own and
    // gives the user nothing to report.
    expect(formatErrorDetail({ message: '   ' })).toBe('unknown error');
    expect(formatErrorDetail('  \n ')).toBe('unknown error');
    expect(formatErrorDetail(new Error('   '))).toBe('Error');
  });

  it('trims surrounding whitespace out of a real detail', () => {
    expect(formatErrorDetail({ message: '  boom  ' })).toBe('boom');
    expect(formatErrorDetail(new Error('  boom  '))).toBe('Error: boom');
  });
});

describe('formatUncaughtError', () => {
  it('joins the context and the detail', () => {
    expect(formatUncaughtError('Playground failed to render', new Error('boom')))
      .toBe('Playground failed to render — Error: boom');
  });

  it('substitutes a label when the context is missing or blank', () => {
    expect(formatUncaughtError('', new Error('boom'))).toBe('Unexpected error — Error: boom');
    expect(formatUncaughtError('   ', new Error('boom'))).toBe('Unexpected error — Error: boom');
  });

  it('still produces a line for a value that cannot be converted', () => {
    expect(formatUncaughtError('Render failed', Object.create(null)))
      .toBe('Render failed — an error that could not be displayed');
  });
});
