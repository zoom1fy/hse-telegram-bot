import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Markup, Telegraf } from 'telegraf';
import { ScheduleService } from '../schedule/schedule.service';
import { ChangeSet, Day } from '../schedule/schedule.types';
import * as fmt from './formatter';
import { Store } from './store';

const PAGE_SIZE = 6;
type Btn = ReturnType<typeof Markup.button.callback>;

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot!: Telegraf;

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

    this.bot = new Telegraf(token);
    this.schedule.onChange = (c) => void this.notify(c);
    this.register();

    this.bot.catch((err) => this.logger.error(`Ошибка бота: ${(err as Error).message}`));
    this.bot.launch();
    void this.setCommands();
    this.logger.log('Telegram-бот запущен');
  }

  async onModuleDestroy() {
    this.bot?.stop();
  }

  private async setCommands() {
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
    } catch (e) {
      this.logger.warn(`Не удалось установить команды: ${(e as Error).message}`);
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

    this.bot.command('today', (ctx) => ctx.reply(this.renderToday(0)));
    this.bot.command('tomorrow', (ctx) => ctx.reply(this.renderToday(1)));
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
      const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('◀️ Назад к списку', `menu:${page}`),
      ]);
      try {
        await ctx.editMessageText(fmt.formatDay(day), keyboard);
      } catch {
        await ctx.reply(fmt.formatDay(day), keyboard);
      }
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
    return this.schedule
      .getDays()
      .filter((d) => d.iso && d.iso >= today && fmt.hasClasses(d));
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
        keyboard: Markup.inlineKeyboard([
          [Markup.button.callback('◀️ Назад', `menu:${page - 1}`)],
        ]),
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

  private mainKeyboard() {
    return Markup.keyboard([
      ['📅 Расписание', '🔔 Уведомления'],
      ['ℹ️ Помощь'],
    ]).resize();
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

  private renderToday(plusDays: number): string {
    const iso = fmt.isoAddDays(fmt.mskTodayIso(), plusDays);
    const day = this.schedule.getDays().find((d) => d.iso === iso);
    return fmt.formatDay(day);
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
