import { IsIn } from 'class-validator';
import { CASE6_POLICIES, type Case6Policy } from '@concurrency/shared';

export class EnqueueQueryDto {
  @IsIn([...CASE6_POLICIES])
  policy!: Case6Policy;
}
