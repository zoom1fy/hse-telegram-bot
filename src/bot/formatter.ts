import { Day, Lesson } from '../schedule/schedule.types';

const WEEKDAYS = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
];

const MONTHS_RU = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

const SEPARATOR = '────────────────────';

export function mskTodayIso(): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  
  const parts = formatter.formatToParts(new Date());
  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

function parseIso(iso: string): number[] {
  return iso.split(/[-/]/).map(Number);
}

export function isoAddDays(iso: string, n: number): string {
  const [y, m, d] = parseIso(iso);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function mondayOfWeek(iso: string): string {
  const [y, m, d] = parseIso(iso);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return isoAddDays(iso, -dow);
}

export function weekdayOf(iso: string): string {
  const [y, m, d] = parseIso(iso);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function isoRu(iso: string): string {
  return iso.split(/[-/]/).reverse().join('.');
}

export function fullDateLabel(iso: string): string {
  const [y, m, d] = parseIso(iso);
  return `${d} ${MONTHS_RU[m - 1]} (${weekdayOf(iso)})`;
}

function visibleLessons(day: Day): Lesson[] {
  return day.lessons.filter(
    (l) => l.time && (l.subject || l.type || l.teacher || l.location),
  );
}

export function hasClasses(day: Day): boolean {
  return day.lessons.some(
    (l) => l.time && (l.subject || l.type || l.teacher || l.location),
  );
}

function formatLesson(l: Lesson, index: number): string {
  const lines: string[] = [];
  lines.push(`🕒 Пара ${index} · ${l.time}`);

  let subject = l.subject ?? '';
  if (l.type) subject = subject ? `${subject} · ${l.type}` : l.type;
  if (subject) lines.push(`📚 Предмет: ${subject}`);

  const place = [l.location, l.room && l.room !== '-' ? `ауд. ${l.room}` : null]
    .filter(Boolean)
    .join(', ');
  if (place) lines.push(`🚪 Аудитория: ${place}`);

  if (l.teacher) {
    lines.push(
      l.teacher === 'асинхронно' ? '💻 асинхронно' : `👨‍🏫 Преподаватель: ${l.teacher}`,
    );
  }

  if (l.note) lines.push(`🔗 ${l.note}`);
  return lines.join('\n');
}

export function formatDay(day: Day | undefined): string {
  if (!day) return 'Нет данных по этому дню.';

  const header = day.iso ? `📅 ${fullDateLabel(day.iso)}` : `📅 ${day.dayName ?? ''} ${day.date ?? ''}`.trim();

  if (day.isVacation) return `${header}\n\n🏖 Каникулы`;
  if (day.isHoliday) return `${header}\n\n🎉 Праздничный день`;

  const lessons = visibleLessons(day);
  if (!lessons.length) return `${header}\n\n🎉 Занятий нет`;

  const body = lessons
    .map((l, i) => formatLesson(l, i + 1))
    .join(`\n\n${SEPARATOR}\n\n`);

  return `${header}\n\n${body}`;
}

export function formatWeek(days: (Day | undefined)[], mondayIso: string): string {
  const sundayIso = isoAddDays(mondayIso, 6);
  const title = `🗓 ${isoRu(mondayIso)} – ${isoRu(sundayIso)}`;

  const body = days.map((d) => formatDay(d)).join(`\n\n${SEPARATOR}\n\n`);
  return `${title}\n\n${body}`;
}

export function formatChange(c: { added: string[]; removed: string[]; changed: string[] }): string {
  const lines: string[] = ['🔄 Расписание обновилось'];

  if (c.added.length) lines.push(`➕ Новые дни: ${c.added.map(isoRu).join(', ')}`);
  if (c.changed.length) lines.push(`✏️ Изменены: ${c.changed.map(isoRu).join(', ')}`);
  if (c.removed.length) lines.push(`➖ Убраны: ${c.removed.map(isoRu).join(', ')}`);

  return lines.join('\n');
}
