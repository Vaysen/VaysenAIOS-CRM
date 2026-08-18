import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateSalesSequenceStepDto {
  @IsInt()
  @Min(0)
  delaySeconds = 0;

  @IsString()
  @IsIn(['EMAIL', 'WHATSAPP'])
  channel!: string;

  @IsObject()
  templateSnapshot!: Record<string, unknown>;
}

export class CreateSalesSequenceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateSalesSequenceStepDto)
  steps!: CreateSalesSequenceStepDto[];
}
