import { BadRequestException } from '@nestjs/common';

interface TreatmentDetails {
  kind: 'recurring' | 'single'; centre_id: string; days: number[]; start_time: string; end_time: string;
  effective_from: string; effective_to: string; replaces_schedule_id?: string; replaces_date?: string;
}
const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number(value.slice(0,4)) > 0 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const validTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function treatmentInput(body: unknown): TreatmentDetails {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Invalid treatment schedule.');
  const b = body as Record<string,unknown>;
  const kind = b.kind === undefined ? 'recurring' : b.kind;
  const keys = ['kind','centre_id','start_time','end_time', ...(kind === 'single' ? ['session_date','replaces_schedule_id','replaces_date'] : ['days','effective_from','effective_to'])];
  if (!['recurring','single'].includes(kind as string) || Object.keys(b).some(key => !keys.includes(key))
    || !validId(b.centre_id) || !validTime(b.start_time) || !validTime(b.end_time) || b.end_time <= b.start_time) throw new BadRequestException('Check the schedule type, centre and session times.');
  if (kind === 'single') {
    if (!validDate(b.session_date)) throw new BadRequestException('A valid session date is required.');
    const replacement = 'replaces_schedule_id' in b || 'replaces_date' in b;
    if (replacement && (!validId(b.replaces_schedule_id) || !validDate(b.replaces_date))) throw new BadRequestException('A recurring schedule and original occurrence date are required.');
    return { kind, centre_id: b.centre_id, days: [new Date(`${b.session_date}T00:00:00Z`).getUTCDay() || 7], start_time: b.start_time, end_time: b.end_time,
      effective_from: b.session_date, effective_to: b.session_date,
      ...(replacement ? { replaces_schedule_id: b.replaces_schedule_id as string, replaces_date: b.replaces_date as string } : {}) };
  }
  if (!Array.isArray(b.days) || b.days.length !== 1 || !Number.isInteger(b.days[0]) || b.days[0] < 1 || b.days[0] > 7
    || !validDate(b.effective_from) || !validDate(b.effective_to) || b.effective_to < b.effective_from) throw new BadRequestException('Check the treatment day and effective dates.');
  const first = Date.parse(b.effective_from) + ((b.days[0] - (new Date(b.effective_from).getUTCDay() || 7) + 7) % 7) * 86400000;
  if (first > Date.parse(b.effective_to)) throw new BadRequestException('The date range must contain the selected weekday.');
  return { kind:'recurring', centre_id:b.centre_id, days:[b.days[0]], start_time:b.start_time, end_time:b.end_time, effective_from:b.effective_from, effective_to:b.effective_to };
}
