// NYSE regular-session calendar 2026-2027 (hardcoded). Times in minutes after 00:00 UTC.
// Regular session 09:30-16:00 ET; early close 13:00 ET. US DST: EDT => 13:30-20:00 UTC, EST => 14:30-21:00 UTC.
// Source: NYSE published holiday/early-close schedule. TODO: re-verify against nyse.com before mainnet; extend past 2027.
export const NYSE_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "New Year's Day", "2026-01-19": "Martin Luther King Jr. Day", "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday", "2026-05-25": "Memorial Day", "2026-06-19": "Juneteenth", "2026-07-03": "Independence Day (observed)",
  "2026-09-07": "Labor Day", "2026-11-26": "Thanksgiving Day", "2026-12-25": "Christmas Day",
  "2027-01-01": "New Year's Day", "2027-01-18": "Martin Luther King Jr. Day", "2027-02-15": "Washington's Birthday",
  "2027-03-26": "Good Friday", "2027-05-31": "Memorial Day", "2027-06-18": "Juneteenth (observed)", "2027-07-05": "Independence Day (observed)",
  "2027-09-06": "Labor Day", "2027-11-25": "Thanksgiving Day", "2027-12-24": "Christmas Day (observed)",
};
/** Early closes at 13:00 ET. */
export const NYSE_EARLY_CLOSES: Record<string, string> = {
  "2026-11-27": "Day after Thanksgiving", "2026-12-24": "Christmas Eve",
  "2027-11-26": "Day after Thanksgiving",
};
// US DST windows (2nd Sunday of March 07:00 UTC -> 1st Sunday of November 06:00 UTC).
const DST: [number, number][] = [
  [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 10, 1, 6)],
  [Date.UTC(2027, 2, 14, 7), Date.UTC(2027, 10, 7, 6)],
];
export const isUsDst = (t: Date) => DST.some(([a, b]) => t.getTime() >= a && t.getTime() < b);

export type Session = { date: string; open: boolean; reason?: string; openMinute?: number; closeMinute?: number; earlyClose?: boolean };
/** The NYSE session for the UTC calendar date of `t` (sessions never cross UTC midnight). */
export function sessionFor(t: Date): Session {
  const date = t.toISOString().slice(0, 10);
  const year = t.getUTCFullYear();
  if (year < 2026 || year > 2027) return { date, open: false, reason: "No calendar for this year (fail closed)" };
  const dow = t.getUTCDay();
  if (dow === 0 || dow === 6) return { date, open: false, reason: "Weekend" };
  if (NYSE_HOLIDAYS[date]) return { date, open: false, reason: `NYSE holiday: ${NYSE_HOLIDAYS[date]}` };
  const off = isUsDst(new Date(`${date}T12:00:00Z`)) ? 4 : 5; // ET offset from UTC
  const openMinute = (9 + off) * 60 + 30;
  const early = !!NYSE_EARLY_CLOSES[date];
  const closeMinute = ((early ? 13 : 16) + off) * 60;
  return { date, open: true, openMinute, closeMinute, earlyClose: early, reason: early ? `Early close: ${NYSE_EARLY_CLOSES[date]}` : undefined };
}
export function isOpenAt(t: Date) {
  const s = sessionFor(t);
  if (!s.open) return false;
  const m = t.getUTCHours() * 60 + t.getUTCMinutes();
  return m >= s.openMinute! && m < s.closeMinute!;
}
/** Next moment >= t that is `offsetMin` minutes after a session open (used to align strategy start times). */
export function nextSessionStart(t: Date, offsetMin = 30): Date {
  for (let d = 0; d < 15; d++) {
    const day = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + d));
    const s = sessionFor(day);
    if (!s.open) continue;
    const start = new Date(day.getTime() + (s.openMinute! + offsetMin) * 60_000);
    if (start.getTime() >= t.getTime()) return start;
    if (t.getTime() < day.getTime() + s.closeMinute! * 60_000) return t; // inside today's session
  }
  return t;
}
