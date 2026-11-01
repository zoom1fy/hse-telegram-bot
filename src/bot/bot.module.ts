import { Module } from '@nestjs/common';
import { ScheduleSyncModule } from '../schedule/schedule.module';
import { BotService } from './bot.service';
import { Store } from './store';

@Module({
  imports: [ScheduleSyncModule],
  providers: [BotService, Store],
})
export class BotModule {}
