import { Controller, Get, Post, Delete, Body, Param, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { TagsService } from './tags.service';
import { CurrentUser } from '@/common/decorators/current-user.decorator';

@ApiTags('Tags')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('tags')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.tagsService.findAll(user);
  }

  @Post()
  create(@Body() dto: { name: string; color?: string }, @CurrentUser() user: any) {
    return this.tagsService.create(dto, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.tagsService.remove(id, user);
  }
}
