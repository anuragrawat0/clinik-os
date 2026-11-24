import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { readPassword } from '../../src/cli/create-admin';

describe('admin password reader', () => {
  it.each([
    ['CRLF', ['pw\r\npw\r\n']],
    ['LF', ['pw\npw\n']],
    ['CR', ['pw\rpw\r']],
    ['CRLF split across chunks', ['pw\r', '\n', 'pw\r', '\n']],
    ['backspace and delete', ['px\bw\r\npwx\x7f\r\n']],
  ] as const)('accepts matching passwords with %s', async (_case, chunks) => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const prompt = vi.fn();
    const result = readPassword(input, prompt);
    for (const chunk of chunks) {
      input.write(chunk);
      await setImmediate();
    }
    input.end();
    await expect(result).resolves.toBe('pw');
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(prompt.mock.calls).toEqual([['Password: '], ['\nConfirm password: '], ['\n']]);
  });

  it('restores the terminal mode when confirmation differs', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const result = readPassword(input, () => {});
    input.end('pw\r\nother\r\n');
    await expect(result).resolves.toBeUndefined();
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });
});
