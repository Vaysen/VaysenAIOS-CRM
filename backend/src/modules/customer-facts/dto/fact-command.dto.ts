import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class FactCommandDto {
  @IsString()
  @IsNotEmpty()
  requestId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
