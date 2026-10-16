import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importLyrics, validate } from '../src/lyrics.ts';
test('plain lyrics are evenly distributed and explicitly marked untimed', () => {
  const result = importLyrics('第一句\n第二句', 12);
  assert.equal(result.timed, false);
  assert.deepEqual(result.cues.map(({ start, end }) => [start, end]), [[0, 6], [6, 12]]);
});
test('LRC supports offset, repeated timestamps and shared bilingual timestamps', () => {
  const result = importLyrics('[offset:500]\n[00:01.00][00:05.00]重复\n[00:01.00]翻译\n[00:08.00]尾句', 10);
  assert.equal(result.timed, true);
  assert.deepEqual(result.cues.map(c => [c.start, c.end, c.text]), [[1.5, 5.5, '重复\n翻译'], [5.5, 8.5, '重复'], [8.5, 10, '尾句']]);
});
test('out-of-range LRC is not silently reinterpreted as plain lyrics', () => {
  assert.throws(() => importLyrics('[01:00]后面的歌词', 5), /超出/);
});
test('invalid duration and overlapping cues cannot be saved or exported', () => {
  const doc = { title: 'test', duration: 10, cues: [{ id: 'a', start: 0, end: 6, text: '一' }, { id: 'b', start: 5, end: 9, text: '二' }] };
  assert.match(validate(doc), /重叠/);
  assert.match(validate({ ...doc, duration: Infinity }), /时长/);
  assert.equal(validate({ ...doc, cues: [{ ...doc.cues[0], end: 5 }, doc.cues[1]] }), null);
});
