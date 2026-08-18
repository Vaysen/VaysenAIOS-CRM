/**
 * add-members.dto.ts
 *
 * R111 批次A 客群系统：手动向客群添加成员（addedReason='manual'）。
 */
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
} from 'class-validator';

export class AddMembersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  leadIds!: string[];
}
