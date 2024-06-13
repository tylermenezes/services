import { contacts, obsidian } from "@/clients";
import schedule from 'node-schedule';
import { markdownFrontmatter, parseVCard, VCardContact } from "@/utils";
import debug from 'debug';

const DEBUG = debug('services:datasources:contacts');

interface PersonNoteFrontmatter {
  email?: string
  tel?: string
  org?: string
  title?: string
  photo?: string
}

let vcards: Record<keyof typeof contacts | 'obsidian', VCardContact[]> = {apple: [], codeday: [], obsidian: []};

export function getContacts() {
  return vcards;
}

type ContactQuery = { givenName?: string, familyName?: string, email?: string };

export function getContact(query: ContactQuery, source?: keyof typeof contacts): VCardContact | null {
  const sourceCards = source
    ? vcards[source]
    : Object.values(vcards).flat()

  return sourceCards.find(c => {
    if (query.email) {
      if (Array.isArray(c.email)) return c.email.includes(query.email);
      return c.email == query.email;
    }
    return c.givenName.toLowerCase() === query.givenName?.toLowerCase()
      && c.familyName.toLowerCase() === query.familyName?.toLowerCase();
  }) || null;
}

async function contactsUpdate() {
  DEBUG(`Updating contacts.`);
  const cardDavPromise = Promise.all(
    Object.entries(contacts)
      .map(async ([source, client]) => {
        await client.login();
        const addressBooks = await client.fetchAddressBooks();
        const cards = (await client.fetchVCards({ addressBook: addressBooks[0] }))
          .map(c => parseVCard(c.data, source))
          .filter(Boolean) as VCardContact[];

        DEBUG(`${cards.length} contacts fetched from ${source}.`);
        vcards[source as keyof typeof contacts] = cards;
      })
  );

  const peopleNoteNames = (await obsidian.noteList()) 
    .filter(n => n.startsWith(`people/@`));
  vcards['obsidian'] = (await obsidian.noteReadMulti(peopleNoteNames))
    .map((n): VCardContact | null => {
      const fm = markdownFrontmatter<PersonNoteFrontmatter>(n.data);
      const names = n.path.slice('people/@'.length).split('.')[0].split(' ');
      let givenName: string | undefined;
      let familyName: string | undefined;

      if (names.length === 0) { return null; }
      else if (names.length === 1) { givenName = names[0]; familyName = ''; }
      else if (names.length === 2) { givenName = names[0]; familyName = names[1]; }
      else if (names.length === 3) { givenName = names[0]; familyName = names.slice(1).join(' ')}
      else { givenName = `${names[0]} ${names[1]}`; familyName = names.slice(2).join(' ')}

      return {
        source: 'obsidian',
        uid: n.path,
        givenName,
        familyName,
        name: [givenName, familyName].join(' '),
        email: (fm?.email && fm.email.includes(',')) ? fm.email.split(',').map(e => e.trim()) : fm?.email,
        tel: (fm?.tel && fm.tel.includes(',')) ? fm.tel.split(',').map(e => e.trim()) : fm?.tel,
        org: fm?.org,
        title: fm?.title,
        photo: fm?.photo,
      }
    })
    .filter(Boolean) as VCardContact[];
    DEBUG(`${vcards['obsidian'].length} contacts fetched from obsidian.`);
    await cardDavPromise;
};

export async function scheduleContactsUpdate() {
  await contactsUpdate();
  const job = schedule.scheduleJob('3 * * * *', scheduleContactsUpdate);
}