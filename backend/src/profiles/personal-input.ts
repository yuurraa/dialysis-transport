import { BadRequestException } from '@nestjs/common';

/** Shared signup validation. Approval and account privileges never come from this payload. */
export function personalInput(input: Record<string, unknown>) {
  const full_name = typeof input.full_name === 'string' ? input.full_name.trim() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const international = phone.match(/^(\+[1-9][0-9]{0,2}) ([0-9]{6,14})$/);
  const validPhone = international
    ? international[1].length - 1 + international[2].length <= 15 && (international[1] !== '+65' || international[2].length === 8)
    : /^[0-9]{8}$/.test(phone);
  const birth_date = typeof input.birth_date === 'string' ? input.birth_date : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(birth_date) ? Date.parse(`${birth_date}T00:00:00Z`) : NaN;
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  if (!full_name || full_name.length > 100 || !validPhone || !Number.isFinite(date)
    || new Date(date).toISOString().slice(0, 10) !== birth_date || birth_date < '1900-01-01' || birth_date > today
    || typeof input.gender !== 'string' || !['female', 'male', 'other', 'prefer-not-to-say'].includes(input.gender)) {
    throw new BadRequestException('Check your name, contact number, date of birth and gender.');
  }
  return { full_name, phone, birth_date, gender: input.gender };
}

export function driverInput(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['full_name', 'phone', 'birth_date', 'gender'].includes(key))) {
    throw new BadRequestException('Invalid driver details.');
  }
  return personalInput(body as Record<string, unknown>);
}
