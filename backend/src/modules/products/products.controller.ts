import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ProductsService } from './products.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';
import { CreateAttributeDto, UpdateAttributeDto } from './dto/create-attribute.dto';
import { CreateProductDto, UpdateProductDto } from './dto/create-product.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Products')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller()
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ========== Categories ==========

  @Get('categories')
  @ApiOperation({ summary: 'List product categories' })
  listCategories(@CurrentUser() user: any) {
    return this.productsService.listCategories(user);
  }

  @Post('categories')
  @ApiOperation({ summary: 'Create product category' })
  createCategory(@CurrentUser() user: any, @Body() dto: CreateCategoryDto) {
    return this.productsService.createCategory(user, dto);
  }

  @Patch('categories/:id')
  @ApiOperation({ summary: 'Update product category' })
  updateCategory(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.productsService.updateCategory(user, id, dto);
  }

  @Delete('categories/:id')
  @ApiOperation({ summary: 'Delete product category' })
  deleteCategory(@CurrentUser() user: any, @Param('id') id: string) {
    return this.productsService.deleteCategory(user, id);
  }

  // ========== Attribute Templates ==========

  @Post('categories/:categoryId/attributes')
  @ApiOperation({ summary: 'Add attribute template to category' })
  createAttribute(
    @CurrentUser() user: any,
    @Param('categoryId') categoryId: string,
    @Body() dto: CreateAttributeDto,
  ) {
    return this.productsService.createAttribute(user, categoryId, dto);
  }

  @Patch('categories/:categoryId/attributes/:attrId')
  @ApiOperation({ summary: 'Update attribute template' })
  updateAttribute(
    @CurrentUser() user: any,
    @Param('categoryId') categoryId: string,
    @Param('attrId') attrId: string,
    @Body() dto: UpdateAttributeDto,
  ) {
    return this.productsService.updateAttribute(user, categoryId, attrId, dto);
  }

  @Delete('categories/:categoryId/attributes/:attrId')
  @ApiOperation({ summary: 'Delete attribute template' })
  deleteAttribute(
    @CurrentUser() user: any,
    @Param('categoryId') categoryId: string,
    @Param('attrId') attrId: string,
  ) {
    return this.productsService.deleteAttribute(user, categoryId, attrId);
  }

  // ========== Products ==========

  @Get('products')
  @ApiOperation({ summary: 'List products' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'productType', required: false })
  listProducts(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
    @Query('productType') productType?: string,
  ) {
    return this.productsService.listProducts(user, { page, limit, categoryId, search, productType });
  }

  @Get('products/search')
  @ApiOperation({ summary: 'Search products with specs for quote' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  searchProducts(
    @CurrentUser() user: any,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return this.productsService.searchProductSpecs(user, { q, categoryId });
  }

  @Get('products/pricing-catalog')
  @ApiOperation({ summary: 'Search the approved USD pricing catalog' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  pricingCatalog(
    @CurrentUser() user: any,
    @Query('q') q?: string,
    @Query('limit') limit?: number,
  ) {
    return this.productsService.searchUsdPricingCatalog(user, q, Number(limit) || 50);
  }

  @Get('products/:id')
  @ApiOperation({ summary: 'Get product detail with specs' })
  getProduct(@CurrentUser() user: any, @Param('id') id: string) {
    return this.productsService.getProduct(user, id);
  }

  @Post('products/:id/specs')
  @ApiOperation({ summary: 'Add product spec' })
  addProductSpec(
    @CurrentUser() user: any,
    @Param('id') productId: string,
    @Body() dto: any,
  ) {
    return this.productsService.addProductSpec(user, productId, dto);
  }

  @Patch('products/:id/specs/:specId')
  @ApiOperation({ summary: 'Update product spec' })
  updateProductSpec(
    @CurrentUser() user: any,
    @Param('id') productId: string,
    @Param('specId') specId: string,
    @Body() dto: any,
  ) {
    return this.productsService.updateProductSpec(user, productId, specId, dto);
  }

  @Delete('products/:id/specs/:specId')
  @ApiOperation({ summary: 'Delete product spec' })
  deleteProductSpec(
    @CurrentUser() user: any,
    @Param('id') productId: string,
    @Param('specId') specId: string,
  ) {
    return this.productsService.deleteProductSpec(user, productId, specId);
  }

  @Post('products')
  @ApiOperation({ summary: 'Create product' })
  createProduct(@CurrentUser() user: any, @Body() dto: CreateProductDto) {
    return this.productsService.createProduct(user, dto);
  }

  @Patch('products/:id')
  @ApiOperation({ summary: 'Update product' })
  updateProduct(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.updateProduct(user, id, dto);
  }

  @Delete('products/:id')
  @ApiOperation({ summary: 'Delete product' })
  deleteProduct(@CurrentUser() user: any, @Param('id') id: string) {
    return this.productsService.deleteProduct(user, id);
  }
}
