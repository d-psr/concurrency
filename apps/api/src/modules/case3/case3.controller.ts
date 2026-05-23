import { Body, Controller, Post } from '@nestjs/common';
import { Case3Service } from './case3.service';
import { DecrementDto } from './dto/decrement.dto';
import { ResetDto } from './dto/reset.dto';

@Controller('case3')
export class Case3Controller {
  constructor(private readonly case3Service: Case3Service) {}

  @Post('reset')
  reset(@Body() dto: ResetDto) {
    return this.case3Service.reset(dto.initial);
  }

  @Post('decrement-naive')
  decrementNaive(@Body() dto: DecrementDto) {
    return this.case3Service.decrementNaive(dto.amount);
  }

  @Post('decrement-atomic')
  decrementAtomic(@Body() dto: DecrementDto) {
    return this.case3Service.decrementAtomic(dto.amount);
  }

  @Post('decrement-pessimistic')
  decrementPessimistic(@Body() dto: DecrementDto) {
    return this.case3Service.decrementPessimistic(dto.amount);
  }

  @Post('decrement-optimistic')
  decrementOptimistic(@Body() dto: DecrementDto) {
    return this.case3Service.decrementOptimistic(dto.amount);
  }
}
