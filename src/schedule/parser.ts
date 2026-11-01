import { Day, Lesson } from './schedule.types';

const DAY_NAMES = new Set([
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
]);

const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;
const VACATION_RE = /каникулы/i;
const HOLIDAY = 'ПРАЗДНИЧНЫЙ ДЕНЬ';

function toIso(date: string): string {
  const [d, m, y] = date.split('.');
  return `${y}-${m}-${d}`;
}

function firstHour(time: string): number {
  const m = time.match(/^(\d{1,2}):/);
  return m ? parseInt(m[1], 10) : -1;
}

function makeLesson(cells: string[]): Lesson {
  return {
    time: (cells[1] ?? '').trim(),
    hours: cells[2] ? cells[2].trim() : null,
    location: cells[3] ? cells[3].trim() : null,
    room: cells[4] ? cells[4].trim() : null,
    subject: cells[5] ? cells[5].trim() : null,
    type: cells[6] ? cells[6].trim() : null,
    teacher: cells[7] ? cells[7].trim() : null,
    note: cells[8] ? cells[8].trim() : null,
  };
}

function isMeaningful(l: Lesson): boolean {
  return !!l.subject || !!l.type || !!l.teacher || !!l.location;
}

function findHeaderIndex(rows: string[][]): number {
  for (let i = 0; i < rows.length; i++) {
    if (/Время начала/i.test(rows[i][1] ?? '')) return i + 1;
  }
  return 3;
}

export function parseSchedule(rows: string[][]): Day[] {
  const data = rows.slice(findHeaderIndex(rows));
  const days: Day[] = [];
  let current: Day | null = null;
  let pending: Lesson[] = [];

  for (const cells of data) {
    const col0 = (cells[0] ?? '').trim();
    const time = (cells[1] ?? '').trim();

    if (DAY_NAMES.has(col0)) {
      const isHoliday = time === HOLIDAY;
      current = {
        dayName: col0,
        date: null,
        iso: null,
        isHoliday,
        isVacation: false,
        lessons: [...pending],
      };
      pending = [];
      if (!isHoliday) current.lessons.push(makeLesson(cells));
      days.push(current);
    } else if (DATE_RE.test(col0)) {
      const lesson = makeLesson(cells);
      if (current) {
        current.date = col0;
        current.iso = toIso(col0);
        if (isMeaningful(lesson) || lesson.time) current.lessons.push(lesson);
      } else {
        current = {
          dayName: null,
          date: col0,
          iso: toIso(col0),
          isHoliday: false,
          isVacation: false,
          lessons: [lesson],
        };
        days.push(current);
      }
    } else {
      if (VACATION_RE.test(cells.join(' '))) {
        if (current) current.isVacation = true;
        continue;
      }
      const lesson = makeLesson(cells);
      if (!lesson.time && !isMeaningful(lesson)) continue;
      if (lesson.time) {
        const hour = firstHour(lesson.time);
        if (hour >= 0 && hour < 12) pending.push(lesson);
        else if (current) current.lessons.push(lesson);
        else pending.push(lesson);
      } else if (current) {
        current.lessons.push(lesson);
      } else {
        pending.push(lesson);
      }
    }
  }

  return days;
}

export function diffDays(oldDays: Day[], newDays: Day[]): { added: string[]; removed: string[]; changed: string[] } {
  const oldMap = new Map<string, Day>();
  for (const d of oldDays) if (d.iso) oldMap.set(d.iso, d);
  const newMap = new Map<string, Day>();
  for (const d of newDays) if (d.iso) newMap.set(d.iso, d);

  const added: string[] = [];
  const changed: string[] = [];
  for (const [iso, day] of newMap) {
    if (!oldMap.has(iso)) added.push(iso);
    else if (JSON.stringify(oldMap.get(iso)) !== JSON.stringify(day)) changed.push(iso);
  }

  const removed: string[] = [];
  for (const iso of oldMap.keys()) {
    if (!newMap.has(iso)) removed.push(iso);
  }

  return { added, removed, changed };
}
