// test-ask.js: tries answerQuestion ("Ask SkySentry") on sample hourly rows.
// The rows look exactly like what Tiger Data returns through the pg library:
//   { hour: Date, type: 'bird', events: '35', total_objects: '160' }   (counts arrive as text)
// Run from inside SHREYANSH/:  node test-ask.js
const { answerQuestion } = require('./ai');
const { localHourLabel } = require('./describe');

// Build sample data relative to now, so "today" questions make sense whenever this runs.
const HOUR = 3600 * 1000;
const thisHour = Math.floor(Date.now() / HOUR) * HOUR;
const hoursAgo = n => new Date(thisHour - n * HOUR);
const row = (n, type, events, objects) => ({ hour: hoursAgo(n), type, events: String(events), total_objects: String(objects) });

const peakHoursAgo = 3; // the busiest bird hour in the sample
const sampleRows = [
  row(30, 'bird', 4, 9),       // yesterday
  row(28, 'bird', 9, 22),
  row(6, 'bird', 6, 14),
  row(5, 'bird', 11, 31),
  row(4, 'drone', 3, 3),       // the only drone activity
  row(peakHoursAgo, 'bird', 35, 160),
  row(2, 'bird', 14, 40),
  row(1, 'bird', 5, 11)
];

// "Sat, Oct 10, 1 PM" -> matches "1 PM" or "1:00 PM" in the answer
const peakLabel = localHourLabel(hoursAgo(peakHoursAgo));
const [, peakHour, peakAmPm] = peakLabel.match(/(\d+)\s*(AM|PM)/);
const mentionsPeak = text => new RegExp(`\\b${peakHour}(:00)?\\s*${peakAmPm}`, 'i').test(text);
const sentences = text => (text.match(/[^.!?]+[.!?]+/g) || [text]).length;

let failures = 0;
async function ask(question, rows, expectation, test) {
  const started = Date.now();
  const answer = await answerQuestion(question, rows);
  const ok = typeof answer === 'string' && answer.length > 0 && sentences(answer) <= 3 && test(answer);
  if (!ok) failures++;
  console.log(`${ok ? 'OK    ' : 'FAILED'}  Q: ${question || '(empty)'}   [${Date.now() - started} ms]`);
  console.log(`        A: ${answer}`);
  console.log(`        expected: ${expectation}\n`);
}

async function main() {
  console.log(`Sample data: ${sampleRows.length} hourly rows; busiest bird hour is ${peakLabel}.\n`);
  await ask('When was bird activity worst?', sampleRows, `mentions ${peakHour} ${peakAmPm}`, mentionsPeak);
  await ask('How many drone events were recorded?', sampleRows, 'says 3 (or three)', a => /\b(3|three)\b/i.test(a));
  await ask('What will the weather be tomorrow?', sampleRows, `"I don't have data on that."`, a => /don.t have data/i.test(a));
  await ask('When were birds worst today?', [], 'no-data answer, without calling Gemini', a => /don.t have data/i.test(a));
  await ask('   ', sampleRows, 'asks for a question', a => /type a question/i.test(a));

  console.log(failures ? `${failures} CHECK(S) FAILED` : 'ALL OK');
  process.exitCode = failures ? 1 : 0;
}

main();
