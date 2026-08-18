import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class AudienceSnapshotDto {
  @IsOptional()
  @IsString()
  segmentId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  leadStatuses?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
