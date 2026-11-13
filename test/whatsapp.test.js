import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseWhatsAppExport, chatNameFromFile } from '../public/shared/whatsapp.js';
import { readTextFromZip } from '../public/shared/unzip.js';

const fx = (f) => new URL('./fixtures/' + f, import.meta.url);

test('iPhone export: multi-line messages, AM/PM with narrow spaces, system and media lines skipped', () => {
  const { messages } = parseWhatsAppExport(fs.readFileSync(fx('ios_chat.txt'), 'utf8'));
  assert.deepEqual(
    messages.map((m) => [m.at, m.sender]),
    [
      ['2026-11-10T19:45', 'Class Teacher 4B'],
      ['2026-11-11T08:15', 'Priya Mom'],
      ['2026-11-12T18:30', 'Class Teacher 4B'],
      ['2026-11-12T18:31', 'Class Teacher 4B'],
      ['2026-11-13T07:05', 'Class Teacher 4B'],
    ]
  );
  assert.equal(messages[0].text, "Dear Parents,\nGrade 4 Science project on 'Water Cycle' to be submitted by Friday.\nThanks");
  // ids are stable, so a re-export can skip what was already imported
  assert.deepEqual(parseWhatsAppExport(fs.readFileSync(fx('ios_chat.txt'), 'utf8')).messages.map((m) => m.id), messages.map((m) => m.id));
});

test('Android export with 24h times', () => {
  const { messages } = parseWhatsAppExport(fs.readFileSync(fx('android_chat.txt'), 'utf8'));
  assert.deepEqual(messages.map((m) => m.at), ['2026-11-10T19:45', '2026-11-12T18:30']);
});

test('month-first exports are detected', () => {
  const { messages, order } = parseWhatsAppExport('[11/25/26, 9:00 AM] T: Fees due by 30/11\n[11/26/26, 9:00 AM] T: Hi');
  assert.equal(order, 'mdy');
  assert.equal(messages[0].date, '2026-11-25');
});

test('reads _chat.txt from the iPhone zip and names the chat', async () => {
  const file = 'WhatsApp Chat - Class 4B Parents.zip';
  const text = await readTextFromZip(fs.readFileSync(fx(file)));
  assert.match(text, /PTM is scheduled/);
  assert.equal(chatNameFromFile(file), 'Class 4B Parents');
});
