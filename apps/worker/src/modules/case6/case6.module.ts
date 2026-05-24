import { Module } from '@nestjs/common';
import { Case6Controller } from './case6.controller';
import { Case6Service } from './case6.service';

@Module({
  controllers: [Case6Controller],
  providers: [Case6Service],
})
export class Case6Module {}
