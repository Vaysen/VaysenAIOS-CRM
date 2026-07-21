import { IsBoolean } from 'class-validator';

export class PublishTemplateDto {
  @IsBoolean()
  published: boolean;
}
