import { Module } from '@nestjs/common';
import { Case7Controller } from './case7.controller';
import { Case7Service } from './case7.service';

@Module({
  controllers: [Case7Controller],
  providers: [Case7Service],
})
export class Case7Module {}
