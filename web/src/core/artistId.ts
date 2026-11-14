/**
 * Artist ID: the public code that says "this person has a Split Tracker account".
 *
 * It looks like ST-7K2Q-9FXM. An artist reads it off their Profile page and gives it to whoever
 * is filling in a split sheet; typing it into the plugin pulls in their name and details and ties
 * that row to their account. It is safe to share: it cannot sign in or upload anything. (The
 * plugin key, which can upload, is a different thing and stays secret.)
 *
 * The last character is a check character, so a mistyped ID is caught even with no connection.
 * Source/ArtistId.h in the plugin implements exactly the same rules.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I, L, O or U: they are easy to misread

function checkChar(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]) * (i + 1);
  return ALPHABET[sum % 32];
}

const format = (eight: string, prefix = 'ST'): string => `${prefix}-${eight.slice(0, 4)}-${eight.slice(4)}`;

/** A new ID from 7 random bytes. */
export function makeArtistId(random: Uint8Array): string {
  let body = '';
  for (let i = 0; i < 7; i++) body += ALPHABET[random[i] & 31];
  return format(body + checkChar(body));
}

/** Tidies what someone typed ("st 7k2q 9fxm", with O for 0 or I for 1) into ST-7K2Q-9FXM, or null if it cannot be an ID. */
export function normaliseArtistId(input: string): string | null {
  return normaliseCode(input, 'ST');
}

/**
 * Song code: the public code of one song on the site, e.g. SG-4MPT-2K7H. A collaborator working in
 * their own separate project types it into their plugin's song details, and that project's records
 * then flow into the same song. Same rules and check character as an Artist ID.
 */
export function makeSongCode(random: Uint8Array): string {
  let body = '';
  for (let i = 0; i < 7; i++) body += ALPHABET[random[i] & 31];
  return format(body + checkChar(body), 'SG');
}
export const normaliseSongCode = (input: string): string | null => normaliseCode(input, 'SG');

function normaliseCode(input: string, prefix: string): string | null {
  let s = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 10 && s.startsWith(prefix)) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 8) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return checkChar(s.slice(0, 7)) === s[7] ? format(s, prefix) : null;
}
