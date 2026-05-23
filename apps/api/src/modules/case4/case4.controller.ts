import { Controller, Get, Post } from '@nestjs/common';
import { Case4Service } from './case4.service';

@Controller('case4')
export class Case4Controller {
  constructor(private readonly case4Service: Case4Service) {}

  @Post('heavy-without-limit')
  heavyWithoutLimit() {
    return this.case4Service.heavyWithoutLimit();
  }

  @Post('heavy-with-limit')
  heavyWithLimit() {
    return this.case4Service.heavyWithLimit();
  }

  @Get('probe')
  probe() {
    return this.case4Service.probe();
  }
}
