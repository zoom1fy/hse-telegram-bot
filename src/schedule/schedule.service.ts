import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { parseCsv } from './csv';
import { diffDays, parseSchedule } from './parser';
import { ChangeSet, Day } from './schedule.types';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Injectable()
export class ScheduleService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleService.name);
  private days: Day[] = [];
  private rawHash = '';
  private refreshing: Promise<void> | null = null;

  onChange?: (changes: ChangeSet) => void;

  private get sheetUrl(): string {
    const id = process.env.SHEET_ID ?? '12zIQ9C2ojtqeCwI_hw8IDVf3k5CP19oEpFefO5dPBsY';
    const gid = process.env.SHEET_GID ?? '263198462';
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  }

  onModuleInit() {
    // Не блокируем старт приложения: если Google недоступен, бот и HTTP-сервер
    // календаря всё равно поднимутся, а расписание догрузится в фоне.
    void this.initialLoad();
  }

  private async initialLoad() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const ok = await this.refreshOnce();
      if (ok || attempt === 5) return;
      const delay = 3_000 * attempt;
      this.logger.warn(`Повторная загрузка расписания через ${delay / 1000} с`);
      await sleep(delay);
    }
  }

  @Cron('0 6-23/2 * * *', { timeZone: 'Europe/Moscow' })
  async handleCron() {
    await this.refreshOnce();
  }

  getDays(): Day[] {
    return this.days;
  }

  /** Обновляет расписание; параллельные вызовы объединяются в один запрос. */
  async refresh(): Promise<void> {
    await this.refreshOnce();
  }

  private async refreshOnce(): Promise<boolean> {
    if (this.refreshing) {
      await this.refreshing;
      return false;
    }

    const before = this.rawHash;

    this.refreshing = this.doRefresh()
      .catch((e) => {
        this.logger.error(`Ошибка обновления расписания: ${(e as Error).message}`);
      })
      .finally(() => {
        this.refreshing = null;
      });

    await this.refreshing;
    return this.rawHash !== before;
  }

  private async doRefresh(): Promise<void> {
    const text = await this.fetchText(this.sheetUrl);
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
  }

  /** Скачивает CSV с таймаутом и повторами при сетевых сбоях. */
  private async fetchText(url: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (e) {
        lastError = e;
        if (attempt < 3) {
          this.logger.warn(
            `Не удалось скачать расписание (попытка ${attempt}): ${(e as Error).message}`,
          );
          await sleep(2_000 * attempt);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return String(h);
}
