import { Module } from '@nestjs/common';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { BotModule } from './bot/bot.module';
import { ScheduleSyncModule } from './schedule/schedule.module';

@Module({
  imports: [NestScheduleModule.forRoot(), ScheduleSyncModule, BotModule],
})
export class AppModule {}
