/** Calendar arithmetic uses UTC dates; the current date is always Singapore's. */
export function planningDateOffset(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0,10);
}
export function planningWindow(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const weekStart = planningDateOffset(today,1-weekday);
  return { today, weekStart, end: planningDateOffset(weekStart,27) };
}
