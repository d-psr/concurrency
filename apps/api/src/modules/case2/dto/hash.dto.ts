import { IsString, MinLength } from 'class-validator';

export class HashDto {
  @IsString()
  @MinLength(1)
  password!: string;
}
