import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CASE3B_CLIENT, CASE3B_QUEUE } from '@concurrency/shared';
import type { Env } from '../../common/config/env.validation';
import { Case3bController } from './case3b.controller';
import { Case3bService } from './case3b.service';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CASE3B_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<Env, true>) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.get<string>('RABBITMQ_URL')],
            queue: CASE3B_QUEUE,
            queueOptions: { durable: true },
          },
        }),
      },
    ]),
  ],
  controllers: [Case3bController],
  providers: [Case3bService],
})
export class Case3bModule {}
