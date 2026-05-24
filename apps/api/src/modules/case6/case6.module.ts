import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { CASE6_RMQ_CLIENT, CASE6_RMQ_QUEUE } from '@concurrency/shared';
import type { Env } from '../../common/config/env.validation';
import { Case6Controller } from './case6.controller';
import { Case6Service } from './case6.service';
import { InMemoryQueueService } from './in-memory-queue.service';
import { RmqService } from './rmq.service';
import { StatsService } from './stats.service';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CASE6_RMQ_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<Env, true>) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.get<string>('RABBITMQ_URL')],
            queue: CASE6_RMQ_QUEUE,
            queueOptions: { durable: true },
          },
        }),
      },
    ]),
  ],
  controllers: [Case6Controller],
  providers: [Case6Service, InMemoryQueueService, RmqService, StatsService],
})
export class Case6Module {}
