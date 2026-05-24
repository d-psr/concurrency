import { IsInt, Min } from 'class-validator';

export class ResetDto {
  @IsInt()
  @Min(0)
  initial!: number;
}
