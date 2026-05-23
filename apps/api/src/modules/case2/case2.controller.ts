import { Body, Controller, Post } from '@nestjs/common';
import { Case2Service } from './case2.service';
import { DecrementDto } from './dto/decrement.dto';
import { ResetDto } from './dto/reset.dto';

@Controller('case2')
export class Case2Controller {
  constructor(private readonly case2Service: Case2Service) {}

  @Post('reset')
  reset(@Body() dto: ResetDto) {
    return this.case2Service.reset(dto.initial);
  }

  @Post('decrement-naive')
  decrementNaive(@Body() dto: DecrementDto) {
    return this.case2Service.decrementNaive(dto.amount);
  }

  @Post('decrement-atomic')
  decrementAtomic(@Body() dto: DecrementDto) {
    return this.case2Service.decrementAtomic(dto.amount);
  }

  @Post('decrement-pessimistic')
  decrementPessimistic(@Body() dto: DecrementDto) {
    return this.case2Service.decrementPessimistic(dto.amount);
  }

  @Post('decrement-optimistic')
  decrementOptimistic(@Body() dto: DecrementDto) {
    return this.case2Service.decrementOptimistic(dto.amount);
  }
}
