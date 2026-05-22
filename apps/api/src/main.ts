import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from '@concurrency/logger';
import { Env } from './common/config/env.validation';

class Server {
  constructor(private readonly app: INestApplication) {}

  private get config(): ConfigService<Env, true> {
    return this.app.get<ConfigService<Env, true>>(ConfigService);
  }

  async init(): Promise<void> {
    this.setupLogger();
    // this.setupSecurity();
    this.setupValidation();

    this.app.enableShutdownHooks();
  }

  private setupLogger(): void {
    this.app.useLogger(this.app.get(WINSTON_MODULE_NEST_PROVIDER));
  }

  private setupValidation(): void {
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
  }

  async bootstrap() {
    const port = this.config.get('PORT');
    const env = this.config.get('NODE_ENV');

    await this.app.listen(port);

    return { port, env };
  }
}

async function main() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const server = new Server(app);
  await server.init();
  return server.bootstrap();
}

main()
  .then(({ port, env }) => {
    new Logger('Bootstrap').log(
      `🚀 pg-nest is running! | 🌍 ${env.toUpperCase()} | 🛜  Port ${port}`,
    );
  })
  .catch((error) => {
    new Logger('Bootstrap').error(
      `❌ pg-nest failed to start! 🛑 ${error.message}`,
      error.stack,
    );
    process.exit(1);
  });
