import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from '@concurrency/logger';
import { NodeEnv, validateEnv, type Env } from './common/config/env.validation';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filter/all-exceptions.filter';
import { HttpExceptionFilter } from './common/filter/http-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        appName: 'api',
        isProduction: config.get('NODE_ENV') === NodeEnv.Production,
      }),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
