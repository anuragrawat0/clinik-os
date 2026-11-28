const legacyTimeZones = new Map(
  [
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['Asia/Katmandu', 'Asia/Kathmandu'],
    ['Asia/Rangoon', 'Asia/Yangon'],
    ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['Etc/UTC', 'UTC'],
    ['Etc/GMT', 'UTC'],
  ].map(([alias, canonical]) => [alias.toLowerCase(), canonical]),
);

const regionTimeZone = /^[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/;

function isAllowedCanonicalTimeZone(value: string): boolean {
  return value === 'UTC' || (regionTimeZone.test(value) && !value.startsWith('Etc/'));
}

export function normalizeTimeZone(value: string): string | undefined {
  // Intl may resolve standalone aliases such as EST and GMT to otherwise allowed zones.
  if (value.toUpperCase() !== 'UTC' && !value.includes('/')) return undefined;
  try {
    const { timeZone } = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions();
    const canonical = canonicalTimeZone(timeZone);
    return isAllowedCanonicalTimeZone(canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function isValidTimeZone(value: string): boolean {
  return normalizeTimeZone(value) !== undefined;
}

export function canonicalTimeZone(value: string): string {
  return legacyTimeZones.get(value.toLowerCase()) ?? value;
}

export function timeZoneOptions(): string[] {
  const zones = Intl.supportedValuesOf('timeZone')
    .map(canonicalTimeZone)
    .filter(isAllowedCanonicalTimeZone);
  return [...new Set(['UTC', ...zones])].sort();
}
