import { Body, Controller, Post } from '@nestjs/common';
import { Case3bService } from './case3b.service';
import { DecrementDto } from './dto/decrement.dto';
import { ResetDto } from './dto/reset.dto';

@Controller('case3b')
export class Case3bController {
  constructor(private readonly case3bService: Case3bService) {}

  @Post('reset')
  reset(@Body() dto: ResetDto) {
    return this.case3bService.reset(dto.initial);
  }

  @Post('decrement-queue')
  decrementQueue(@Body() dto: DecrementDto) {
    return this.case3bService.decrementQueue(dto.amount);
  }

  @Post('decrement-redis')
  decrementRedis(@Body() dto: DecrementDto) {
    return this.case3bService.decrementRedis(dto.amount);
  }
}
