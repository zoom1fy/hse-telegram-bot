process.env.TZ = 'Europe/Moscow';

import 'reflect-metadata';
import * as dns from 'node:dns';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// На части хостингов IPv6 до api.telegram.org «висит»: соединение сначала
// уходит в мёртвый IPv6 и только потом падает с socket hang up / таймаутом.
// Предпочитаем IPv4 — это заметно ускоряет и стабилизирует соединение.
dns.setDefaultResultOrder('ipv4first');

// Сетевые сбои Telegram API и Google Sheets не должны ронять процесс:
// логируем их и продолжаем работу (бот сам переподключится / обновится по cron).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack ?? err);
});

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });
  app.enableShutdownHooks();
}

bootstrap().catch((err) => {
  console.error('Не удалось запустить приложение:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
