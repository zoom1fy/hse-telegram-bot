export interface Lesson {
  time: string;
  hours: string | null;
  location: string | null;
  room: string | null;
  subject: string | null;
  type: string | null;
  teacher: string | null;
  note: string | null;
}

export interface Day {
  dayName: string | null;
  date: string | null;
  iso: string | null;
  isHoliday: boolean;
  isVacation: boolean;
  lessons: Lesson[];
}

export interface ChangeSet {
  added: string[];
  removed: string[];
  changed: string[];
}
