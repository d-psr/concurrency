import { Controller, Get, Post, Query } from '@nestjs/common';
import { Case6Service } from './case6.service';
import { EnqueueQueryDto } from './dto/enqueue.dto';

@Controller('case6')
export class Case6Controller {
  constructor(private readonly case6Service: Case6Service) {}

  @Post('enqueue')
  enqueue(@Query() query: EnqueueQueryDto) {
    return this.case6Service.enqueue(query.policy);
  }

  @Get('stats')
  stats() {
    return this.case6Service.stats();
  }

  @Post('reset')
  reset() {
    return this.case6Service.reset();
  }
}
