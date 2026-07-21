import { Controller, Get, Post, Delete, Param, UseGuards, Req, UseInterceptors, UploadedFile, Body, Res } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MaterialsService } from './materials.service';
import { CurrentUser } from '@/common/decorators/current-user.decorator';

@ApiTags('Materials')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('materials')
export class MaterialsController {
  constructor(private readonly service: MaterialsService) {}

  @Get()
  findAll(@CurrentUser() user: any) {
    return this.service.findAll(user);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @CurrentUser() user: any,
  ) {
    return this.service.upload(file, name, user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.remove(id, user);
  }
}
