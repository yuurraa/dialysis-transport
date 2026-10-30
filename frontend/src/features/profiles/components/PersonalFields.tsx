export interface PersonalDetails { full_name: string; phone: string; birth_date: string; gender: string }
export const genderLabels: Record<string, string> = { female: 'Female', male: 'Male', other: 'Other', 'prefer-not-to-say': 'Prefer not to say' };
export const emptyPersonal: PersonalDetails = { full_name: '', phone: '', birth_date: '', gender: '' };

/** Personal information shared by signup and account details. */
export function PersonalFields({ draft, onChange, disabled = false, prefix }: {
  draft: PersonalDetails; onChange: (value: PersonalDetails) => void; disabled?: boolean; prefix: string;
}) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return <>
    <div className="patient-field"><label className="patient-required" htmlFor={`${prefix}-full-name`}>Full name</label><input id={`${prefix}-full-name`} disabled={disabled} required maxLength={100} value={draft.full_name} onChange={event => onChange({ ...draft, full_name: event.target.value })} autoComplete="name" /></div>
    <div className="patient-field"><label className="patient-required" htmlFor={`${prefix}-phone`}>Contact number</label><input id={`${prefix}-phone`} disabled={disabled} type="tel" required maxLength={17} pattern={String.raw`(?:[0-9]{8}|\+65 [0-9]{8}|\+(?!65 )[1-9][0-9]{0,2} [0-9]{6,14})`} title="Enter 8 digits, or a country code and number, e.g. +65 81234567." placeholder="e.g. +65 81234567" value={draft.phone} onChange={event => onChange({ ...draft, phone: event.target.value })} autoComplete="tel" /></div>
    <div className="patient-field"><label className="patient-required" htmlFor={`${prefix}-birth-date`}>Date of birth</label><input id={`${prefix}-birth-date`} disabled={disabled} type="date" required min="1900-01-01" max={today} value={draft.birth_date} onChange={event => onChange({ ...draft, birth_date: event.target.value })} autoComplete="bday" /></div>
    <div className="patient-field"><label className="patient-required" htmlFor={`${prefix}-gender`}>Gender</label><select id={`${prefix}-gender`} disabled={disabled} required value={draft.gender} onChange={event => onChange({ ...draft, gender: event.target.value })}><option value="">Choose gender</option>{Object.entries(genderLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
  </>;
}
