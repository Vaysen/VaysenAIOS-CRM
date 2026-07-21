import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { MergeCustomerCommand, MergeableField } from '../../customer-identity/dto/merge-customer.dto';

class MergeFieldChoiceDto {
  @IsIn(['companyName', 'country', 'website', 'industry'])
  field!: MergeableField;

  @IsIn(['source', 'target'])
  winner!: 'source' | 'target';
}

export class MergeLeadsDto {
  @IsUUID()
  companyId!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(64)
  candidateId!: string;

  @IsISO8601({ strict: true })
  targetUpdatedAt!: string;

  @IsIn(['trusted_defaults', 'field_choices'])
  mode!: MergeCustomerCommand['mode'];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MergeFieldChoiceDto)
  fieldChoices!: MergeFieldChoiceDto[];
}
