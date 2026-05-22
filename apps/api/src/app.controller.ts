import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '@concurrency/database';

@Controller()
export class AppController {
  constructor(private readonly prismaService: PrismaService) {}

  @Get()
  async getHello() {
    return this.prismaService.credential.findMany();
  }
}
