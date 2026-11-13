import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, findDate, findTime, undatedItem } from '../src/parser.js';

const today = new Date(2026, 10, 11); // Wed 11 Nov 2026
const children = [
  { id: 'a', name: 'Aarav', grade: 'Grade 4 · 4B' },
  { id: 'm', name: 'Meera', grade: 'Grade 1 · 1A' },
];
const SAMPLE = `Dear Parents,
Grade 4 Science project on 'Water Cycle' to be submitted by Friday.
PTM is scheduled on 21st Nov, 10:30 am in the school auditorium.
Kindly send ₹200 for the field trip by 18/11.
Thanks, Class Teacher 4B`;

test('splits a class message into dated items', () => {
  const items = parseMessage(SAMPLE, { children, today });
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => [i.type, i.date, i.time, i.childId]),
    [
      ['Assignment', '2026-11-13', '', 'a'],
      ['Meeting', '2026-11-21', '10:30', 'a'],
      ['Task', '2026-11-18', '', 'a'],
    ]
  );
  assert.equal(items[0].title, "Grade 4 Science project on 'Water Cycle' due");
  assert.equal(items[1].title, 'Parent–Teacher Meeting (PTM)');
  assert.equal(items[1].location, 'School auditorium');
  assert.equal(items[2].title, 'Send ₹200 for the field trip');
});

test('dates: day-first numbers, month names, relative words', () => {
  const ymd = (s) => {
    const d = findDate(s, today).date;
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  assert.equal(ymd('due 5/12'), '2026-12-5');
  assert.equal(ymd('on Dec 3rd'), '2026-12-3');
  assert.equal(ymd('on 2 Jan'), '2027-1-2'); // no year, already past → next year
  assert.equal(ymd('tomorrow'), '2026-11-12');
  assert.equal(ymd('next Wednesday'), '2026-11-18');
  assert.equal(ymd('Wednesday'), '2026-11-11');
  assert.equal(findDate('no date here', today), null);
});

test('times', () => {
  assert.equal(findTime('at 4 pm').time, '16:00');
  assert.equal(findTime('10.15 a.m.').time, '10:15');
  assert.equal(findTime('at 12 pm').time, '12:00');
  assert.equal(findTime('at 14:30').time, '14:30');
});

test('class signature sets the child for unnamed lines; a name prefix is stripped', () => {
  const items = parseMessage(SAMPLE + "\nMeera: Children's Day celebration tomorrow at 8:30 am", { children, today });
  assert.deepEqual(items.map((i) => i.childId), ['a', 'a', 'a', 'm']);
  assert.equal(items[3].title, "Children's Day celebration");
});

test('child by name wins over grade', () => {
  const [it] = parseMessage('Meera must bring crayons tomorrow (Grade 4 note)', { children, today });
  assert.equal(it.childId, 'm');
  assert.equal(it.type, 'Task');
});

test('several dated sentences on one line become separate items', () => {
  const items = parseMessage('Kindly pay term 2 fees by 25/11. Annual day on 28th Nov at 5 pm in the auditorium.', { children, today });
  assert.deepEqual(items.map((i) => [i.title, i.date, i.time]), [
    ['Pay term 2 fees', '2026-11-25', ''],
    ['Annual day', '2026-11-28', '17:00'],
  ]);
});

test('more date formats teachers use', () => {
  const ymd = (s) => {
    const r = findDate(s, today);
    return r && `${r.date.getFullYear()}-${r.date.getMonth() + 1}-${r.date.getDate()}`;
  };
  assert.equal(ymd('Annual day on 15.11.2026'), '2026-11-15');
  assert.equal(ymd('on 20.12.26'), '2026-12-20');
  assert.equal(ymd('15-Nov-2026'), '2026-11-15');
  assert.equal(ymd("Fancy dress 18th Nov'26"), '2026-11-18');
  assert.equal(ymd('November 20th, 2026'), '2026-11-20');
  assert.equal(ymd('PTM 21st Nov, 10:30 am'), '2026-11-21');
  assert.equal(ymd('Submit by the 17th'), '2026-11-17');
  assert.equal(ymd('Submit by 5th'), '2026-12-5');
  assert.equal(ymd('this Friday'), '2026-11-13');
  assert.equal(ymd('pick up at 10.30 am'), null);
  assert.equal(ymd('Rs 1.50 per page'), null);
});

test('notice layout with Date:/Time:/Venue: lines becomes one item', () => {
  const items = parseMessage(`Dear Parents,

Annual Day Celebration
Date: 15.11.2026
Time: 10 am
Venue: School Auditorium

Regards,
Principal`, { children, today });
  assert.deepEqual(items.map((i) => [i.title, i.date, i.time, i.location]), [['Annual Day Celebration', '2026-11-15', '10:00', 'School Auditorium']]);
});

test('text shared from WhatsApp keeps the message date for "tomorrow"', () => {
  const items = parseMessage('[09/11/26, 6:30 PM] Class Teacher 4B: Bring a white kerchief tomorrow.', { children, today });
  assert.deepEqual(items.map((i) => [i.title, i.date]), [['Bring a white kerchief', '2026-11-10']]);
});

test('undated message still yields an item title', () => {
  const it = undatedItem('Dear Parents,\nPlease ensure children carry their library books.\nThanks', { children });
  assert.equal(it.title, 'Ensure children carry their library books');
  assert.equal(it.type, 'Task'); // "carry" is something parents must do
});
