import { Module } from '@nestjs/common';
import { Case3Controller } from './case3.controller';
import { Case3Service } from './case3.service';

@Module({
  controllers: [Case3Controller],
  providers: [Case3Service],
})
export class Case3Module {}
