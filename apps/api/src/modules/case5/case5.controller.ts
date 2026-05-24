import { Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Case5Service } from './case5.service';

@Controller('case5')
export class Case5Controller {
  constructor(private readonly case5Service: Case5Service) {}

  @Post('reset')
  reset() {
    return this.case5Service.reset();
  }

  @Get('probe')
  probe() {
    return this.case5Service.probe();
  }

  @Get('product-naive/:id')
  productNaive(@Param('id', ParseIntPipe) id: number) {
    return this.case5Service.getNaive(id);
  }

  @Get('product-singleflight/:id')
  productSingleflight(@Param('id', ParseIntPipe) id: number) {
    return this.case5Service.getSingleflight(id);
  }

  @Get('product-redis-lock/:id')
  productRedisLock(@Param('id', ParseIntPipe) id: number) {
    return this.case5Service.getRedisLock(id);
  }

  @Get('product-xfetch/:id')
  productXfetch(@Param('id', ParseIntPipe) id: number) {
    return this.case5Service.getXfetch(id);
  }
}
