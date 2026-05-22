import { Module } from '@nestjs/common';
import { Case1Controller } from './case1.controller';
import { Case1Service } from './case1.service';

@Module({
  controllers: [Case1Controller],
  providers: [Case1Service],
})
export class Case1Module {}
