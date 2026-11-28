import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Timezone, useSingleFlightSubmit } from '../../src/features/m1/ui';

/**
 * m-14 (audit-report.md): a double click used to send the mutation twice because
 * `mutation.isPending` is read from the render closure. The Playwright double-click test is
 * CI-only, so this exercises the in-flight guard directly.
 *
 * M-2 (audit-report.md): an organization already storing a legacy IANA alias must still show a
 * matching option in the time zone dropdown.
 */
type RunSubmit = (submit: () => Promise<unknown>) => Promise<void>;

function captureGuard(): RunSubmit {
  let guard: RunSubmit | undefined;
  function Probe() {
    guard = useSingleFlightSubmit();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!guard) throw new Error('useSingleFlightSubmit did not return a guard');
  return guard;
}

function optionValues(markup: string): string[] {
  return [...markup.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((match) => match[1]);
}

describe('useSingleFlightSubmit', () => {
  it('sends one mutation when invoked twice before the first settles', async () => {
    const runSubmit = captureGuard();
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = async () => {
      calls.push('submit');
      await held;
    };

    const first = runSubmit(submit);
    const second = runSubmit(submit);
    expect(calls).toEqual(['submit']);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(['submit']);
  });

  it('allows the next submit after the first succeeds', async () => {
    const runSubmit = captureGuard();
    const calls: string[] = [];
    await runSubmit(async () => {
      calls.push('first');
    });
    await runSubmit(async () => {
      calls.push('second');
    });
    expect(calls).toEqual(['first', 'second']);
  });

  it('allows the next submit after the first fails', async () => {
    const runSubmit = captureGuard();
    const calls: string[] = [];
    await expect(
      runSubmit(async () => {
        calls.push('failing');
        throw new Error('Synthetic mutation failure');
      }),
    ).resolves.toBeUndefined();
    await runSubmit(async () => {
      calls.push('recovered');
    });
    expect(calls).toEqual(['failing', 'recovered']);
  });
});

describe('time zone dropdown for a stored legacy alias', () => {
  it('keeps Asia/Calcutta selectable when it is the stored value', () => {
    const values = optionValues(renderToStaticMarkup(<Timezone initial="Asia/Calcutta" />));
    expect(values.filter((value) => value === 'Asia/Calcutta')).toHaveLength(1);
    expect(values).toContain('Asia/Kolkata');
    expect(values).not.toContain('Etc/UTC');
  });

  it('lists a canonical value once without duplicating the stored option', () => {
    const values = optionValues(renderToStaticMarkup(<Timezone initial="UTC" />));
    expect(values.filter((value) => value === 'UTC')).toHaveLength(1);
  });

  it('requires a choice when the stored zone no longer passes validation', () => {
    const markup = renderToStaticMarkup(<Timezone initial="Etc/GMT+5" />);
    expect(optionValues(markup)).not.toContain('Etc/GMT+5');
    expect(markup).toMatch(/<option[^>]*selected=""[^>]*>Select a supported time zone<\/option>/);
  });
});
