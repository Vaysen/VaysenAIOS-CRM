import { IsNotEmpty, IsString } from 'class-validator';

export class EnrollSalesSequenceDto {
  @IsString()
  @IsNotEmpty()
  leadId!: string;
}
