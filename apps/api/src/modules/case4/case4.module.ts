import { Module } from '@nestjs/common';
import { Case4Controller } from './case4.controller';
import { Case4Service } from './case4.service';
import { case4PrismaProvider } from './case4.prisma';

@Module({
  controllers: [Case4Controller],
  providers: [case4PrismaProvider, Case4Service],
})
export class Case4Module {}
