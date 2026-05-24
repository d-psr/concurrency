import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from '@concurrency/logger';
import { PrismaModule } from '@concurrency/database';
import { RedisModule } from '@concurrency/redis';
import { NodeEnv, validateEnv, type Env } from './common/config/env.validation';
import { Case3bModule } from './modules/case3b/case3b.module';
import { Case6Module } from './modules/case6/case6.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        appName: 'worker',
        isProduction: config.get('NODE_ENV') === NodeEnv.Production,
      }),
    }),
    PrismaModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        datasourceUrl: config.get('DATABASE_URL'),
      }),
    }),
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        url: config.get('REDIS_URL'),
      }),
    }),
    Case3bModule,
    Case6Module,
  ],
})
export class AppModule {}
