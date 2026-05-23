import { IsInt, Min } from 'class-validator';

export class DecrementDto {
  @IsInt()
  @Min(1)
  amount!: number;
}
