import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { INestMicroservice, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from '@concurrency/logger';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import {
  CASE3B_QUEUE,
  CASE6_PREFETCH,
  CASE6_RMQ_QUEUE,
} from '@concurrency/shared';
import { Env, validateEnv } from './common/config/env.validation';

async function createRmqApp(
  env: Env,
  queue: string,
  prefetchCount: number,
): Promise<INestMicroservice> {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [env.RABBITMQ_URL],
        queue,
        queueOptions: { durable: true },
        prefetchCount,
        noAck: false,
      },
      bufferLogs: true,
    },
  );
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.enableShutdownHooks();
  await app.listen();
  return app;
}

async function main() {
  const env = validateEnv(process.env);

  const case3bApp = await createRmqApp(env, CASE3B_QUEUE, 1);
  const case6App = await createRmqApp(env, CASE6_RMQ_QUEUE, CASE6_PREFETCH);

  const nodeEnv = case3bApp
    .get<ConfigService<Env, true>>(ConfigService)
    .get('NODE_ENV');

  void case6App;

  return { env: nodeEnv };
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
