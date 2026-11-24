import { Day, Lesson } from './schedule.types';

const MSK_OFFSET_MINUTES = 3 * 60; // Europe/Moscow = UTC+3 (без перехода на летнее время)
const DEFAULT_LESSON_MINUTES = 80; // одна пара, если в таблице нет времени окончания

interface TimeRange {
  start: number;
  end: number;
}

/** Достаёт время начала/окончания из строки вида "18:10 - 19:30". */
export function parseTimeRange(time: string | null): TimeRange | null {
  if (!time) return null;

  const range = time.match(/(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/);
  if (range) {
    const start = Number(range[1]) * 60 + Number(range[2]);
    let end = Number(range[3]) * 60 + Number(range[4]);
    if (end <= start) end = start + DEFAULT_LESSON_MINUTES;
    return { start, end };
  }

  const single = time.match(/(\d{1,2}):(\d{2})/);
  if (single) {
    const start = Number(single[1]) * 60 + Number(single[2]);
    return { start, end: start + DEFAULT_LESSON_MINUTES };
  }

  return null;
}

function formatUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Минуты от полуночи по Москве -> UTC-таймстамп для ICS. */
function toUtc(iso: string, minutes: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + minutes * 60_000 - MSK_OFFSET_MINUTES * 60_000;
  return formatUtc(new Date(ms));
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function fold(line: string): string {
  const limit = 70;
  if (line.length <= limit) return line;

  const chunks: string[] = [line.slice(0, limit)];
  for (let i = limit; i < line.length; i += limit - 1) {
    chunks.push(` ${line.slice(i, i + limit - 1)}`);
  }
  return chunks.join('\r\n');
}

function eventSummary(lesson: Lesson): string {
  const subject = lesson.subject?.trim();
  const type = lesson.type?.trim();
  if (subject && type) return `${subject} (${type})`;
  return subject || type || 'Занятие';
}

function eventDescription(lesson: Lesson): string {
  const lines: string[] = [];
  if (lesson.type) lines.push(`Вид занятий: ${lesson.type}`);
  if (lesson.teacher) {
    if (isUrl(lesson.teacher)) lines.push(`Ссылка: ${lesson.teacher}`);
    else if (lesson.teacher !== 'асинхронно') lines.push(`Преподаватель: ${lesson.teacher}`);
  }
  if (lesson.note && !isUrl(lesson.note)) lines.push(lesson.note);
  return lines.join('\n');
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function eventLocation(lesson: Lesson): string {
  const room = lesson.room && lesson.room !== '-' ? `ауд. ${lesson.room}` : null;
  return [lesson.location, room].filter(Boolean).join(', ');
}

function eventUrl(lesson: Lesson): string | null {
  for (const value of [lesson.note, lesson.teacher]) {
    const text = value?.trim();
    if (text && isUrl(text)) return text;
  }
  return null;
}

export interface DayCalendar {
  /** Содержимое .ics-файла (CRLF, как требует RFC 5545). */
  content: string;
  /** Имя файла для отправки в Telegram. */
  filename: string;
  /** Количество событий в календаре. */
  events: number;
}

interface EventItem {
  lesson: Lesson;
  range: TimeRange;
  /** Отображаемое время (после склейки сдвоенной пары — общий интервал). */
  time: string;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalize(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Сдвоенная пара часто записана двумя строками (18:10–19:30 и 19:40–21:00)
 * с одинаковыми предметом/преподавателем/аудиторией. Склеиваем такие занятия
 * в одно событие, чтобы в календаре не было двух карточек подряд.
 */
function canMerge(prev: EventItem, next: EventItem): boolean {
  const a = prev.lesson;
  const b = next.lesson;
  const gap = next.range.start - prev.range.end;
  if (gap < 0 || gap > 20) return false;
  if (!normalize(a.subject) || normalize(a.subject) !== normalize(b.subject)) return false;
  if (normalize(a.teacher) !== normalize(b.teacher)) return false;
  if (normalize(a.location) !== normalize(b.location)) return false;
  if (normalize(a.room) !== normalize(b.room)) return false;
  if (normalize(a.note) !== normalize(b.note)) return false;
  return true;
}

function mergeTypes(a: string | null, b: string | null): string | null {
  const first = a?.trim() ?? '';
  const second = b?.trim() ?? '';
  if (!first) return second || null;
  if (!second || normalize(first) === normalize(second)) return first;
  return `${first}, ${second}`;
}

function mergeItems(items: EventItem[]): EventItem[] {
  const merged: EventItem[] = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (prev && canMerge(prev, item)) {
      merged[merged.length - 1] = {
        lesson: {
          ...prev.lesson,
          type: mergeTypes(prev.lesson.type, item.lesson.type),
        },
        range: { start: prev.range.start, end: Math.max(prev.range.end, item.range.end) },
        time: `${formatMinutes(prev.range.start)} - ${formatMinutes(Math.max(prev.range.end, item.range.end))}`,
      };
      continue;
    }
    merged.push(item);
  }
  return merged;
}

/**
 * Собирает .ics с занятиями одного дня.
 * Файл открывается в Apple Календаре (iPhone/Mac), Google Календаре и т.п.
 */
export function buildDayIcs(day: Day): DayCalendar | null {
  if (!day.iso) return null;

  const lessons = day.lessons
    .map((lesson) => ({ lesson, range: parseTimeRange(lesson.time) }))
    .filter(
      (item): item is { lesson: Lesson; range: TimeRange } =>
        item.range !== null &&
        Boolean(
          item.lesson.subject || item.lesson.type || item.lesson.teacher || item.lesson.location,
        ),
    )
    .sort((a, b) => a.range.start - b.range.start)
    .map((item): EventItem => ({ ...item, time: item.lesson.time.trim() }));

  const events = mergeItems(lessons);
  if (!events.length) return null;

  const stamp = formatUtc(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HSE Schedule Bot//VPI 26//RU',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Расписание ВПИ 26',
    'X-WR-TIMEZONE:Europe/Moscow',
  ];

  events.forEach(({ lesson, range, time }, index) => {
    const summary = eventSummary(lesson);
    const description = eventDescription(lesson);
    const location = eventLocation(lesson);
    const url = eventUrl(lesson);
    const details = [time, description].filter(Boolean).join('\n');

    lines.push(
      'BEGIN:VEVENT',
      `UID:${day.iso}-${range.start}-${index}@vpi26.hse.bot`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toUtc(day.iso as string, range.start)}`,
      `DTEND:${toUtc(day.iso as string, range.end)}`,
      `SUMMARY:${escapeText(summary)}`,
    );

    if (details) lines.push(`DESCRIPTION:${escapeText(details)}`);
    if (location) lines.push(`LOCATION:${escapeText(location)}`);
    if (url) lines.push(`URL:${url}`);

    lines.push(
      'STATUS:CONFIRMED',
      'SEQUENCE:0',
      'TRANSP:OPAQUE',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Скоро занятие',
      'END:VALARM',
      'END:VEVENT',
    );
  });

  lines.push('END:VCALENDAR');

  const content = `${lines.map(fold).join('\r\n')}\r\n`;

  return {
    content,
    filename: `vpi26-${day.iso}.ics`,
    events: events.length,
  };
}
