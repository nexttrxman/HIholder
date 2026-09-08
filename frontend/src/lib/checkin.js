/**
 * Daily check-in rules — MIRROR of cloudflare-worker/lib.js.
 *
 * Generated from the worker source so both sides agree on the streak and the
 * ISO week. If you edit one, edit the other (or re-run the copy).
 */

// ============================================
// DAILY CHECK-IN
// ============================================

export const CHECKIN_CONFIG = {
  DAILY_REWARD_USDT: 0.05,
  WEEKLY_BONUS_USDT: 0.5,
  DAYS_FOR_WEEKLY: 7,
};

const MS_PER_DAY = 86400000;

/** 'YYYY-MM-DD' in UTC — the same granularity the checkins table stores. */
export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * ISO-8601 week key, e.g. '2026-W37'. Matches the SQL
 * to_char(now() AT TIME ZONE 'UTC', 'IYYY-"W"IW') so the worker and the
 * database agree on which week a check-in belongs to.
 */
export function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of this week decides the ISO year.
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / MS_PER_DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * A streak continues only from the immediately previous UTC day; any gap
 * restarts it at 1.
 *
 * @param {string[]} dayKeys  'YYYY-MM-DD' strings, any order
 * @param {Date} [now]
 * @returns {number}
 */
export function computeStreak(dayKeys, now = new Date()) {
  const set = new Set(dayKeys);
  let streak = 0;
  let cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Today may or may not be done yet; start counting from today and walk back.
  for (;;) {
    if (!set.has(utcDayKey(cursor))) {
      // today not done yet is fine — the streak so far still counts
      if (streak === 0 && utcDayKey(cursor) === utcDayKey(now)) {
        cursor = new Date(cursor.getTime() - MS_PER_DAY);
        continue;
      }
      break;
    }
    streak += 1;
    cursor = new Date(cursor.getTime() - MS_PER_DAY);
  }
  return streak;
}

/**
 * Read-side status for the Missions card.
 *
 * @param {{checkin_date: string, week_key?: string}[]} rows
 * @param {Date} [now]
 */
export function summarizeCheckins(rows, now = new Date()) {
  const list = Array.isArray(rows) ? rows : [];
  const today = utcDayKey(now);
  const week = isoWeekKey(now);

  const dayKeys = list.map((r) => String(r.checkin_date).slice(0, 10));
  const thisWeek = list.filter(
    (r) => (r.week_key ? r.week_key : isoWeekKey(new Date(`${String(r.checkin_date).slice(0, 10)}T00:00:00Z`))) === week
  );

  const daysThisWeek = new Set(thisWeek.map((r) => String(r.checkin_date).slice(0, 10))).size;
  const checkedInToday = dayKeys.includes(today);

  return {
    checked_in_today: checkedInToday,
    streak: computeStreak(dayKeys, now),
    days_this_week: daysThisWeek,
    days_for_weekly: CHECKIN_CONFIG.DAYS_FOR_WEEKLY,
    days_to_weekly: Math.max(0, CHECKIN_CONFIG.DAYS_FOR_WEEKLY - daysThisWeek),
    weekly_complete: daysThisWeek >= CHECKIN_CONFIG.DAYS_FOR_WEEKLY,
    daily_reward: CHECKIN_CONFIG.DAILY_REWARD_USDT,
    weekly_bonus: CHECKIN_CONFIG.WEEKLY_BONUS_USDT,
  };
}
