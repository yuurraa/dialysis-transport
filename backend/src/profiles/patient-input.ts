import { BadRequestException } from '@nestjs/common';

export function patientInput(body: unknown, includeStatus: boolean) {
  const allowed = ['full_name', 'phone', 'pickup_address', 'mobility', 'assistance_required', 'unit_no', 'postal_code', 'notes', ...(includeStatus ? ['status'] : [])];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new BadRequestException('Invalid patient details.');
  const input = body as Record<string, unknown>;
  const name = typeof input.full_name === 'string' ? input.full_name.trim() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const address = typeof input.pickup_address === 'string' ? input.pickup_address.trim() : '';
  const international = phone.match(/^(\+[1-9][0-9]{0,2}) ([0-9]{6,14})$/);
  const validPhone = international
    ? international[1].length - 1 + international[2].length <= 15 && (international[1] !== '+65' || international[2].length === 8)
    : /^[0-9]{8}$/.test(phone);
  if (!name || name.length > 100 || !validPhone || !address || address.length > 300
    || !['ambulant', 'walking-aid', 'wheelchair'].includes(String(input.mobility)) || typeof input.mobility !== 'string'
    || typeof input.assistance_required !== 'boolean' || (includeStatus && (!['active', 'inactive'].includes(String(input.status)) || typeof input.status !== 'string'))) {
    throw new BadRequestException('Check the required patient details.');
  }
  const extra: Record<string, string> = {};
  for (const [field, limit] of [['unit_no', 20], ['postal_code', 6], ['notes', 1000]] as const) {
    if (!(field in input)) continue;
    const value = input[field];
    if (typeof value !== 'string' || value.trim().length > limit || (field === 'postal_code' && !/^[0-9]{6}$/.test(value.trim()))) throw new BadRequestException('Check the address and notes.');
    extra[field] = value.trim();
  }
  return { full_name: name, phone, pickup_address: address, ...extra, mobility: input.mobility, assistance_required: input.assistance_required, ...(includeStatus ? { status: input.status } : {}) };
}
