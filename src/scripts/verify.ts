import { parseCsv } from '../schedule/csv';
import { parseSchedule } from '../schedule/parser';

const id = process.env.SHEET_ID ?? '12zIQ9C2ojtqeCwI_hw8IDVf3k5CP19oEpFefO5dPBsY';
const gid = process.env.SHEET_GID ?? '263198462';
const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;

async function main() {
  const res = await fetch(url);
  const text = await res.text();
  const days = parseSchedule(parseCsv(text));
  console.log(`Всего дней: ${days.length}`);

  for (const d of days.slice(0, 8)) {
    console.log('---');
    console.log(`${d.dayName ?? '?'} ${d.date ?? '?'} (${d.iso}) holiday=${d.isHoliday} vacation=${d.isVacation}`);
    for (const l of d.lessons) {
      if (!l.subject && !l.type && !l.teacher && !l.location) continue;
      console.log(`   ${l.time} | ${l.subject ?? '-'} | ${l.type ?? '-'} | ${l.location ?? '-'} ${l.room ?? ''}`);
    }
  }
}

void main();
