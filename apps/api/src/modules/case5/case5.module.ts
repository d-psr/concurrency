import { Module } from '@nestjs/common';
import { Case5Controller } from './case5.controller';
import { Case5Service } from './case5.service';
import { case5PrismaProvider } from './case5.prisma';

@Module({
  controllers: [Case5Controller],
  providers: [case5PrismaProvider, Case5Service],
})
export class Case5Module {}
