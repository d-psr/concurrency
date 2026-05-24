import { Body, Controller, Post } from '@nestjs/common';
import { Case7Service } from './case7.service';
import { DecrementDto } from './dto/decrement.dto';
import { ResetDto } from './dto/reset.dto';

@Controller('case7')
export class Case7Controller {
  constructor(private readonly case7Service: Case7Service) {}

  @Post('reset')
  reset(@Body() dto: ResetDto) {
    return this.case7Service.reset(dto.initial);
  }

  @Post('inproc-mutex/decrement')
  decrementInprocMutex(@Body() dto: DecrementDto) {
    return this.case7Service.decrementInprocMutex(dto.amount);
  }

  @Post('redis-setnx/decrement')
  decrementRedisSetnx(@Body() dto: DecrementDto) {
    return this.case7Service.decrementRedisSetnx(dto.amount);
  }

  @Post('redlock/decrement')
  decrementRedlock(@Body() dto: DecrementDto) {
    return this.case7Service.decrementRedlock(dto.amount);
  }

  @Post('db-row-lock/decrement')
  decrementDbRowLock(@Body() dto: DecrementDto) {
    return this.case7Service.decrementDbRowLock(dto.amount);
  }
}
