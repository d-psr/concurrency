import { IsString, MinLength } from 'class-validator';

export class HashCredentialDto {
  @IsString()
  @MinLength(1)
  password!: string;
}
