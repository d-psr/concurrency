import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import {
  CASE6_WORK_PATTERN,
  type Case6WorkPayload,
  type Case6WorkResult,
} from '@concurrency/shared';
import { Case6Service } from './case6.service';

@Controller()
export class Case6Controller {
  constructor(private readonly case6Service: Case6Service) {}

  @MessagePattern(CASE6_WORK_PATTERN)
  async work(
    @Payload() payload: Case6WorkPayload,
    @Ctx() context: RmqContext,
  ): Promise<Case6WorkResult> {
    const channel = context.getChannelRef();
    const message = context.getMessage();
    try {
      const result = await this.case6Service.work(payload);
      channel.ack(message);
      return result;
    } catch (error) {
      channel.nack(message, false, false);
      throw error;
    }
  }
}
