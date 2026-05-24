import { Controller } from '@nestjs/common';
import { Ctx, MessagePattern, Payload, RmqContext } from '@nestjs/microservices';
import {
  CASE3B_DECREMENT_PATTERN,
  type Case3bDecrementPayload,
  type Case3bDecrementResult,
} from '@concurrency/shared';
import { Case3bService } from './case3b.service';

@Controller()
export class Case3bController {
  constructor(private readonly case3bService: Case3bService) {}

  @MessagePattern(CASE3B_DECREMENT_PATTERN)
  async decrement(
    @Payload() payload: Case3bDecrementPayload,
    @Ctx() context: RmqContext,
  ): Promise<Case3bDecrementResult> {
    const channel = context.getChannelRef();
    const message = context.getMessage();
    try {
      const result = await this.case3bService.decrement(payload.amount);
      channel.ack(message);
      return result;
    } catch (error) {
      channel.nack(message, false, false);
      throw error;
    }
  }
}
