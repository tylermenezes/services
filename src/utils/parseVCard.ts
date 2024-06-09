import ICAL from 'ical.js';

type VCardLine = [string, object, string, string | string[] | undefined]
type VCardValue = { meta: object, type: string, value?: string | string[] }
interface VCardObject {
  version?: VCardValue
  n?: VCardValue
  fn?: VCardValue
  nickname?: VCardValue
  adr?: VCardValue
  email?: VCardValue
  org?: VCardValue
  title?: VCardValue
  photo?: VCardValue
  url?: VCardValue
  bday?: VCardValue
  note?: VCardValue
  uid?: VCardValue
  prodid?: VCardValue
  tel?: VCardValue
  [s: string]: VCardValue | undefined
}

export interface VCardContact {
  uid: string
  source: string
  givenName: string
  familyName: string
  name: string
  discriminator?: string
  email?: string | string[]
  tel?: string | string[]
  org?: string
  title?: string
  photo?: string
}

function vCardValueStringify(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join('');
}

export function parseVCard(dataString: string, source: string): VCardContact | null {
  const [type, data] = ICAL.parse(dataString);
  if (type !== 'vcard' || !data) return null;
  const vcard: VCardObject = Object.fromEntries(
    data.map(([key, meta, type, value]: VCardLine): [string, VCardValue] => [key, { meta, type, value }])
  );
  if (!vcard?.n?.value) return null;
  const name = (
    typeof vcard.n.value === 'string'
      ? vcard.n.value.split(' ').reverse()
      : vcard.n.value
  ).filter(Boolean);

  const discriminator = name?.[0]?.startsWith('[') ? name[0] : undefined;
  const givenName = (discriminator ? name[2] : name[1]) || undefined;
  const familyName = (discriminator ? name[1] : name[0]) || undefined;
  if (!givenName || !familyName) return null;

  return {
    source,
    uid: vCardValueStringify(vcard.uid!.value)!,
    givenName,
    familyName,
    name: `${givenName} ${familyName}`,
    discriminator,
    email: vCardValueStringify(vcard.email?.value),
    tel: vCardValueStringify(vcard.tel?.value),
    org: vCardValueStringify(vcard.org?.value),
    title: vCardValueStringify(vcard.title?.value),
    photo: vCardValueStringify(vcard.photo?.value),
  };
}