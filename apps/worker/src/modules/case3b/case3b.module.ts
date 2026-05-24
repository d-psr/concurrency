import { Module } from '@nestjs/common';
import { Case3bController } from './case3b.controller';
import { Case3bService } from './case3b.service';
import { Case3bFlusherService } from './case3b-flusher.service';

@Module({
  controllers: [Case3bController],
  providers: [Case3bService, Case3bFlusherService],
})
export class Case3bModule {}
