import { BadRequestException } from '@nestjs/common';
import { personalInput } from './personal-input';

export function patientInput(body: unknown, includeStatus: boolean) {
  const allowed = ['birth_date', 'gender', 'full_name', 'phone', 'pickup_address', 'mobility', 'assistance_required', 'unit_no', 'postal_code', 'notes', ...(includeStatus ? ['status'] : [])];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new BadRequestException('Invalid patient details.');
  const input = body as Record<string, unknown>;
  const personal = personalInput(input);
  const address = typeof input.pickup_address === 'string' ? input.pickup_address.trim() : '';
  if (!address || address.length > 300
    || !['ambulant', 'walking-aid', 'wheelchair'].includes(String(input.mobility)) || typeof input.mobility !== 'string'
    || typeof input.assistance_required !== 'boolean' || (includeStatus && (!['active', 'inactive'].includes(String(input.status)) || typeof input.status !== 'string'))) {
    throw new BadRequestException('Check the required patient details.');
  }
  const extra: Partial<Record<'unit_no' | 'postal_code' | 'notes', string>> = {};
  for (const [field, limit] of [['unit_no', 20], ['postal_code', 6], ['notes', 1000]] as const) {
    if (!(field in input)) continue;
    const value = input[field];
    if (typeof value !== 'string' || value.trim().length > limit || (field === 'postal_code' && !/^[0-9]{6}$/.test(value.trim()))) throw new BadRequestException('Check the address and notes.');
    extra[field] = value.trim();
  }
  return { ...personal, pickup_address: address, ...extra, mobility: input.mobility, assistance_required: input.assistance_required, ...(includeStatus ? { status: input.status } : {}) };
}
