import { Module } from '@nestjs/common';
import { Case2Controller } from './case2.controller';
import { Case2Service } from './case2.service';

@Module({
  controllers: [Case2Controller],
  providers: [Case2Service],
})
export class Case2Module {}
