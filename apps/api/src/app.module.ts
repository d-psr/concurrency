import {
  ClassSerializerInterceptor,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from '@concurrency/logger';
import { PrismaModule } from '@concurrency/database';
import { NodeEnv, validateEnv, type Env } from './common/config/env.validation';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { APP_FILTER, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { AllExceptionsFilter } from './common/filter/all-exceptions.filter';
import { HttpExceptionFilter } from './common/filter/http-exception.filter';
import { LoggingInterceptor } from './common/interceptor/logging.interceptor';
import { TransformInterceptor } from './common/interceptor/transform.interceptor';
import { PrismaExceptionFilter } from './common/filter/prisma-exception.filter';
import { Case1Module } from './modules/case1/case1.module';
import { Case3Module } from './modules/case3/case3.module';

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
    PrismaModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        datasourceUrl: config.get('DATABASE_URL'),
      }),
    }),
    Case1Module,
    Case3Module,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },

    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    {
      provide: APP_INTERCEPTOR,
      useFactory: (reflector: Reflector) =>
        new ClassSerializerInterceptor(reflector, {
          excludeExtraneousValues: false,
        }),
      inject: [Reflector],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
