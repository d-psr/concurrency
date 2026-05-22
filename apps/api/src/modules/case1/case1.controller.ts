import { Body, Controller, Get, Post } from '@nestjs/common';
import { Case1Service } from './case1.service';
import { HashCredentialDto } from './dto/hash-credential.dto';

@Controller('case1')
export class Case1Controller {
  constructor(private readonly case1Service: Case1Service) {}

  @Post('without-limit')
  hashWithoutLimit(@Body() dto: HashCredentialDto) {
    return this.case1Service.hashAndInsertWithoutLimit(dto.password);
  }

  @Post('with-limit')
  hashWithLimit(@Body() dto: HashCredentialDto) {
    return this.case1Service.hashAndInsertWithLimit(dto.password);
  }

  @Get('io')
  io() {
    return this.case1Service.fileIo();
  }
}
