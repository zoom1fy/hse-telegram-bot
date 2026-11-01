import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { parseCsv } from './csv';
import { diffDays, parseSchedule } from './parser';
import { ChangeSet, Day } from './schedule.types';

@Injectable()
export class ScheduleService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleService.name);
  private days: Day[] = [];
  private rawHash = '';

  onChange?: (changes: ChangeSet) => void;

  private get sheetUrl(): string {
    const id = process.env.SHEET_ID ?? '12zIQ9C2ojtqeCwI_hw8IDVf3k5CP19oEpFefO5dPBsY';
    const gid = process.env.SHEET_GID ?? '263198462';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }

  async onModuleInit() {
    await this.refresh();
  }

  @Cron('0 6-23/2 * * *', { timeZone: 'Europe/Moscow' })
  async handleCron() {
    await this.refresh();
  }

  getDays(): Day[] {
    return this.days;
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(this.sheetUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const hash = hashString(text);
      if (hash === this.rawHash) {
        this.logger.log('Расписание без изменений');
        return;
      }

      const rows = parseCsv(text);
      const newDays = parseSchedule(rows);
      const oldDays = this.days;

      this.days = newDays;
      this.rawHash = hash;
      this.logger.log(`Расписание обновлено: ${newDays.length} дней`);

      if (oldDays.length > 0) {
        const changes = diffDays(oldDays, newDays);
        if (changes.added.length || changes.changed.length || changes.removed.length) {
          this.onChange?.(changes);
        }
      }
    } catch (e) {
      this.logger.error(`Ошибка обновления расписания: ${(e as Error).message}`);
    }
  }
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}
