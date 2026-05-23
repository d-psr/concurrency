import { Body, Controller, Get, Post } from '@nestjs/common';
import { Case2Service } from './case2.service';
import { HashDto } from './dto/hash.dto';

@Controller('case2')
export class Case2Controller {
  constructor(private readonly case2Service: Case2Service) {}

  @Post('sync-hash')
  syncHash(@Body() dto: HashDto) {
    return this.case2Service.syncHash(dto.password);
  }

  @Post('async-hash')
  asyncHash(@Body() dto: HashDto) {
    return this.case2Service.asyncHash(dto.password);
  }

  @Post('worker-hash')
  workerHash(@Body() dto: HashDto) {
    return this.case2Service.workerHash(dto.password);
  }

  @Get('health')
  health() {
    return this.case2Service.health();
  }
}
