import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Markup, Telegraf, TelegramError } from 'telegraf';
import type { Context } from 'telegraf';
import { buildDayIcs } from '../schedule/ics';
import { ScheduleService } from '../schedule/schedule.service';
import { ChangeSet, Day } from '../schedule/schedule.types';
import * as fmt from './formatter';
import { Store } from './store';

const PAGE_SIZE = 6;
type Btn = ReturnType<typeof Markup.button.callback>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/**
 * Настройки Telegram-клиента из окружения:
 * - TELEGRAM_API_ROOT — адрес Bot API (в т. ч. self-hosted/proxy);
 * - TELEGRAM_PROXY — HTTP(S) или SOCKS5-прокси, если api.telegram.org недоступен напрямую.
 */
function telegramOptions(): Partial<Telegraf.Options<Context>> | undefined {
  const apiRoot = process.env.TELEGRAM_API_ROOT?.trim();
  const proxy = process.env.TELEGRAM_PROXY?.trim();
  if (!apiRoot && !proxy) return undefined;

  const telegram: Record<string, unknown> = {};
  if (apiRoot) telegram.apiRoot = apiRoot;
  if (proxy) {
    telegram.agent = /^socks/i.test(proxy)
      ? new SocksProxyAgent(proxy)
      : new HttpsProxyAgent(proxy);
  }
  return { telegram } as Partial<Telegraf.Options<Context>>;
}

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot!: Telegraf;
  private stopping = false;
  /** Последнее отправленное сообщение с .ics — чтобы не плодить дубликаты. */
  private readonly calendarMessages = new Map<number, number>();

  constructor(
    private readonly schedule: ScheduleService,
    private readonly store: Store,
  ) {}

  async onModuleInit() {
    const token = process.env.BOT_TOKEN;
    if (!token) {
      this.logger.error('BOT_TOKEN не задан — бот не запущен');
      return;
    }

    this.bot = new Telegraf(token, telegramOptions());
    this.schedule.onChange = (c) => void this.notify(c);
    this.register();

    this.bot.catch((err) => this.logger.error(`Ошибка бота: ${(err as Error).message}`));
    void this.startBot();
  }

  async onModuleDestroy() {
    this.stopping = true;
    try {
      this.bot?.stop();
    } catch {}
  }

  // Запускает long polling с повторами
  private async startBot() {
    let attempt = 0;

    while (!this.stopping) {
      attempt += 1;
      try {
        if (!this.bot.botInfo) {
          this.bot.botInfo = await this.fetchBotInfo(30_000);
        }

        await this.bot.launch({ dropPendingUpdates: true }, () => {
          this.logger.log('Telegram-бот запущен');
          void this.setCommands();
        });
        return; // штатная остановка бота
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.error(`Не удалось запустить бота (попытка ${attempt}): ${message}`);

        if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) {
          this.logger.error('BOT_TOKEN недействителен — перезапуск не поможет, проверь токен');
          return;
        }

        if (this.stopping) return;

        let delay: number;
        const retryAfter = this.retryAfterMs(e);

        if (retryAfter > 0) {
          // Telegram сам говорит, сколько ждать. Игнорировать это нельзя:
          // слишком частые повторы продлевают блокировку.
          delay = Math.min(retryAfter + 2_000, 15 * 60_000);
          this.logger.warn(
            `Telegram ограничил частоту запросов (429) — жду ${Math.ceil(delay / 1000)} с`,
          );
        } else if (e instanceof TelegramError && e.code === 409) {
          delay = 60_000;
          this.logger.warn(
            'Конфликт 409: похоже, этот же бот уже запущен в другом контейнере или процессе',
          );
        } else {
          delay = Math.min(60_000, 5_000 * 2 ** Math.min(attempt - 1, 4));
        }

        delay += Math.floor(Math.random() * 1_000);
        this.logger.log(`Повторный запуск через ${Math.round(delay / 1000)} с`);
        await sleep(delay);
      }
    }
  }

  private retryAfterMs(e: unknown): number {
    if (!(e instanceof TelegramError)) return 0;
    const seconds = e.parameters?.retry_after;
    return typeof seconds === 'number' && seconds > 0 ? seconds * 1000 : 0;
  }

  private async fetchBotInfo(timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.bot.telegram.callApi(
        'getMe',
        {},
        {
          signal: controller.signal as never,
        },
      );
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`getMe: таймаут ${timeoutMs / 1000} с`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async setCommands() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.bot.telegram.setMyCommands([
          { command: 'start', description: 'Показать расписание' },
          { command: 'menu', description: 'Список ближайших занятий' },
          { command: 'today', description: 'Сегодня' },
          { command: 'tomorrow', description: 'Завтра' },
          { command: 'week', description: 'Текущая неделя' },
          { command: 'notifications', description: 'Настройка уведомлений' },
          { command: 'subscribe', description: 'Уведомления об изменениях' },
          { command: 'unsubscribe', description: 'Отключить уведомления' },
        ]);
        return;
      } catch (e) {
        this.logger.warn(
          `Не удалось установить команды (попытка ${attempt}): ${(e as Error).message}`,
        );
        if (attempt < 3) {
          const retryAfter = this.retryAfterMs(e);
          await sleep(retryAfter > 0 ? Math.min(retryAfter + 2_000, 60_000) : 2_000 * attempt);
        }
      }
    }
  }

  private register() {
    this.bot.start((ctx) =>
      ctx.reply(
        '👋 Привет! Я показываю расписание группы ВПИ 26.\n\n' +
          '📅 Расписание — ближайшие занятия\n' +
          '🔔 Уведомления — подписка на изменения\n' +
          'ℹ️ Помощь — список команд',
        this.mainKeyboard(),
      ),
    );

    this.bot.help((ctx) =>
      ctx.reply(
        'Команды:\n' +
          '/menu — список ближайших занятий\n' +
          '/today — сегодня\n' +
          '/tomorrow — завтра\n' +
          '/week — текущая неделя\n' +
          '/notifications — настройка уведомлений\n' +
          '/subscribe — включить уведомления\n' +
          '/unsubscribe — отключить уведомления',
        this.mainKeyboard(),
      ),
    );

    this.bot.command('menu', (ctx) => {
      const view = this.menu(0);
      return ctx.reply(view.text, view.keyboard);
    });

    this.bot.command('notifications', async (ctx) => {
      const v = await this.renderNotifications(ctx.chat.id);
      return ctx.reply(v.text, v.keyboard);
    });

    this.bot.hears('📅 Расписание', (ctx) => {
      const view = this.menu(0);
      return ctx.reply(view.text, view.keyboard);
    });

    this.bot.hears('🔔 Уведомления', async (ctx) => {
      const v = await this.renderNotifications(ctx.chat.id);
      return ctx.reply(v.text, v.keyboard);
    });

    this.bot.hears('ℹ️ Помощь', (ctx) => {
      return ctx.reply(
        'Команды:\n' +
          '/menu — список ближайших занятий\n' +
          '/today — сегодня\n' +
          '/tomorrow — завтра\n' +
          '/week — текущая неделя\n' +
          '/notifications — настройка уведомлений',
        this.mainKeyboard(),
      );
    });

    this.bot.command('today', (ctx) => {
      const view = this.renderToday(0);
      return ctx.reply(view.text, view.keyboard);
    });
    this.bot.command('tomorrow', (ctx) => {
      const view = this.renderToday(1);
      return ctx.reply(view.text, view.keyboard);
    });
    this.bot.command('week', (ctx) => ctx.reply(this.renderWeek(0), this.weekKeyboard(0)));

    this.bot.command('subscribe', async (ctx) => {
      await this.store.add(ctx.chat.id);
      await ctx.reply('✅ Буду присылать уведомления об изменениях расписания.');
    });

    this.bot.command('unsubscribe', async (ctx) => {
      await this.store.remove(ctx.chat.id);
      await ctx.reply('🔕 Уведомления отключены.');
    });

    this.bot.action(/^menu:(-?\d+)$/, async (ctx) => {
      const page = Math.max(0, Number(ctx.match[1]));
      await ctx.answerCbQuery();
      const view = this.menu(page);
      try {
        await ctx.editMessageText(view.text, view.keyboard);
      } catch {
        await ctx.reply(view.text, view.keyboard);
      }
    });

    this.bot.action(/^day:(\d{4}-\d{2}-\d{2}):(-?\d+)$/, async (ctx) => {
      const iso = ctx.match[1];
      const page = Math.max(0, Number(ctx.match[2]));
      await ctx.answerCbQuery();
      const day = this.schedule.getDays().find((d) => d.iso === iso);
      try {
        await ctx.editMessageText(fmt.formatDay(day), this.dayKeyboard(day, page));
      } catch {
        await ctx.reply(fmt.formatDay(day), this.dayKeyboard(day, page));
      }
    });

    this.bot.action(/^cal:(\d{4}-\d{2}-\d{2})(?::(-?\d+))?$/, async (ctx) => {
      const iso = ctx.match[1];
      const page = Math.max(0, Number(ctx.match[2] ?? 0));
      const day = this.schedule.getDays().find((d) => d.iso === iso);
      const calendar = day ? buildDayIcs(day) : null;

      if (!calendar) {
        await ctx.answerCbQuery('На этот день занятий нет', {
          show_alert: true,
        });
        return;
      }

      await ctx.answerCbQuery();

      // Telegram не позволяет прикрепить файл к текстовому сообщению.
      // Поэтому убираем карточку дня и отправляем файл на её место:
      // визуально сообщение «превращается» в календарь, а кнопка «Назад»
      // возвращает карточку. Чат не разрастается.
      const chatId = ctx.chat?.id;
      if (chatId) await this.removePreviousCalendar(chatId);
      await this.deleteCurrent(ctx);

      try {
        const sent = await ctx.replyWithDocument(
          {
            source: Buffer.from(calendar.content, 'utf8'),
            filename: calendar.filename,
          },
          {
            caption:
              `📆 Календарь на ${fmt.fullDateLabel(iso)}\n` +
              `${plural(calendar.events, 'событие', 'события', 'событий')} · ` +
              'открой файл и выбери «Добавить в календарь».\n\n' +
              'Если iPhone не предлагает добавить сразу: «Поделиться» → ' +
              '«Сохранить в Файлы», затем открой файл из «Файлов».',
            reply_markup: this.calendarBackKeyboard(iso, page),
          },
        );
        if (chatId) this.calendarMessages.set(chatId, sent.message_id);
      } catch (e) {
        this.logger.warn(`Не удалось отправить календарь: ${(e as Error).message}`);
        await this.restoreDay(iso, page, ctx);
      }
    });

    this.bot.action(/^calback:(\d{4}-\d{2}-\d{2}):(-?\d+)$/, async (ctx) => {
      const iso = ctx.match[1];
      const page = Math.max(0, Number(ctx.match[2]));
      const chatId = ctx.chat?.id;
      await ctx.answerCbQuery();
      if (chatId) this.calendarMessages.delete(chatId);
      await this.deleteCurrent(ctx);
      await this.restoreDay(iso, page, ctx);
    });

    this.bot.action(/^week:(-?\d+)$/, async (ctx) => {
      const offset = Number(ctx.match[1]);
      await ctx.answerCbQuery();
      try {
        await ctx.editMessageText(this.renderWeek(offset), this.weekKeyboard(offset));
      } catch {
        await ctx.reply(this.renderWeek(offset), this.weekKeyboard(offset));
      }
    });

    this.bot.action('notify:toggle', async (ctx) => {
      await ctx.answerCbQuery();
      const id = ctx.chat?.id ?? ctx.from?.id;
      if (!id) return;
      if (await this.store.has(id)) {
        await this.store.remove(id);
      } else {
        await this.store.add(id);
      }
      const v = await this.renderNotifications(id);
      try {
        await ctx.editMessageText(v.text, v.keyboard);
      } catch {
        await ctx.reply(v.text, v.keyboard);
      }
    });
  }

  private upcomingDays(): Day[] {
    const today = fmt.mskTodayIso();
    return this.schedule.getDays().filter((d) => d.iso && d.iso >= today && fmt.hasClasses(d));
  }

  private menu(page: number) {
    const all = this.upcomingDays();
    const start = page * PAGE_SIZE;
    const days = all.slice(start, start + PAGE_SIZE);
    const hasMore = start + PAGE_SIZE < all.length;

    if (!days.length && page === 0) {
      return {
        text: 'Расписание пока не загружено. Попробуй позже.',
        keyboard: Markup.inlineKeyboard([]),
      };
    }
    if (!days.length) {
      return {
        text: 'Дальше занятий пока нет.',
        keyboard: Markup.inlineKeyboard([[Markup.button.callback('◀️ Назад', `menu:${page - 1}`)]]),
      };
    }

    const rows: Btn[][] = days.map((d) => [
      Markup.button.callback(fmt.fullDateLabel(d.iso as string), `day:${d.iso}:${page}`),
    ]);

    const nav: Btn[] = [];
    if (page > 0) nav.push(Markup.button.callback('◀️', `menu:${page - 1}`));
    if (hasMore) nav.push(Markup.button.callback('Далее ▶️', `menu:${page + 1}`));
    if (nav.length) rows.push(nav);

    const text = page === 0 ? '📅 Ближайшие занятия\n\nВыбери дату:' : '📅 Занятия\n\nВыбери дату:';
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  private weekKeyboard(offset: number) {
    return Markup.inlineKeyboard([
      Markup.button.callback('◀️', `week:${offset - 1}`),
      Markup.button.callback('▶️', `week:${offset + 1}`),
    ]);
  }

  private dayKeyboard(day: Day | undefined, page: number) {
    const rows: Btn[][] = [];
    if (day?.iso && fmt.hasClasses(day)) {
      rows.push([this.calendarButton(day.iso, page)]);
    }
    rows.push([Markup.button.callback('◀️ Назад к списку', `menu:${page}`)]);
    return Markup.inlineKeyboard(rows);
  }

  private calendarButton(iso: string, page: number): Btn {
    return Markup.button.callback('📆 Добавить в календарь', `cal:${iso}:${page}`);
  }

  private calendarBackKeyboard(iso: string, page: number) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('◀️ Назад к расписанию', `calback:${iso}:${page}`)],
    ]).reply_markup;
  }

  private async deleteCurrent(ctx: Context): Promise<void> {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      this.logger.warn(`Не удалось удалить сообщение: ${(e as Error).message}`);
    }
  }

  private async removePreviousCalendar(chatId: number): Promise<void> {
    const messageId = this.calendarMessages.get(chatId);
    if (!messageId) return;
    this.calendarMessages.delete(chatId);
    try {
      await this.bot.telegram.deleteMessage(chatId, messageId);
    } catch {
      // сообщение могло быть уже удалено — это нормально
    }
  }

  private async restoreDay(iso: string, page: number, ctx: Context): Promise<void> {
    const day = this.schedule.getDays().find((d) => d.iso === iso);
    await ctx.reply(fmt.formatDay(day), this.dayKeyboard(day, page));
  }

  private mainKeyboard() {
    return Markup.keyboard([['📅 Расписание', '🔔 Уведомления'], ['ℹ️ Помощь']]).resize();
  }

  private async renderNotifications(chatId: number) {
    const subscribed = await this.store.has(chatId);
    const text = subscribed
      ? '🔔 Уведомления включены.\nЯ пришлю сообщение, когда расписание изменится.'
      : '🔕 Уведомления выключены.\nНажми кнопку, чтобы подписаться на изменения.';
    const keyboard = Markup.inlineKeyboard([
      Markup.button.callback(subscribed ? '🔕 Отключить' : '🔔 Включить', 'notify:toggle'),
    ]);
    return { text, keyboard };
  }

  private renderToday(plusDays: number) {
    const iso = fmt.isoAddDays(fmt.mskTodayIso(), plusDays);
    const day = this.schedule.getDays().find((d) => d.iso === iso);
    const keyboard =
      day?.iso && fmt.hasClasses(day)
        ? Markup.inlineKeyboard([[this.calendarButton(day.iso, 0)]])
        : undefined;
    return { text: fmt.formatDay(day), keyboard };
  }

  private renderWeek(offset: number): string {
    const monday = fmt.isoAddDays(fmt.mondayOfWeek(fmt.mskTodayIso()), offset * 7);
    const byIso = new Map<string, Day>();
    for (const d of this.schedule.getDays()) if (d.iso) byIso.set(d.iso, d);

    const days: (Day | undefined)[] = [];
    for (let i = 0; i < 7; i++) {
      days.push(byIso.get(fmt.isoAddDays(monday, i)));
    }
    return fmt.formatWeek(days, monday);
  }

  private async notify(c: ChangeSet) {
    if (!c.added.length && !c.changed.length && !c.removed.length) return;
    const text = fmt.formatChange(c);
    const ids = await this.store.all();
    for (const id of ids) {
      try {
        await this.bot.telegram.sendMessage(id, text);
      } catch (e) {
        this.logger.warn(`Не удалось отправить уведомление в ${id}`);
      }
    }
  }
}
