import { expect, it } from 'vitest';
import { auditTimestampOptions } from '../../src/features/m1/audit';

it('includes the time-zone name in an audit timestamp', () => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...auditTimestampOptions,
    timeZone: 'UTC',
  });
  const instant = new Date('2026-01-15T12:34:56Z');

  expect(formatter.formatToParts(instant)).toContainEqual({ type: 'timeZoneName', value: 'UTC' });
  expect(formatter.format(instant)).toContain('UTC');
});
