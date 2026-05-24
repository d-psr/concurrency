import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { INestMicroservice, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from '@concurrency/logger';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { CASE3B_QUEUE } from '@concurrency/shared';
import { Env, validateEnv } from './common/config/env.validation';

class Worker {
  constructor(private readonly app: INestMicroservice) {}

  private get config(): ConfigService<Env, true> {
    return this.app.get<ConfigService<Env, true>>(ConfigService);
  }

  async init(): Promise<void> {
    this.setupLogger();

    this.app.enableShutdownHooks();
  }

  private setupLogger(): void {
    this.app.useLogger(this.app.get(WINSTON_MODULE_NEST_PROVIDER));
  }

  async bootstrap() {
    const env = this.config.get('NODE_ENV');

    await this.app.listen();

    return { env };
  }
}

async function main() {
  const env = validateEnv(process.env);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [env.RABBITMQ_URL],
        queue: CASE3B_QUEUE,
        queueOptions: { durable: true },
        prefetchCount: 1,
        noAck: false,
      },
      bufferLogs: true,
    },
  );

  const worker = new Worker(app);
  await worker.init();
  return worker.bootstrap();
}

main()
  .then(({ env }) => {
    new Logger('Bootstrap').log(
      `🛠  worker is running! | 🌍 ${env.toUpperCase()}`,
    );
  })
  .catch((error) => {
    new Logger('Bootstrap').error(
      `❌ worker failed to start! 🛑 ${error.message}`,
      error.stack,
    );
    process.exit(1);
  });
