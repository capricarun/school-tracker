import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, findDate, findTime } from '../src/parser.js';

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
