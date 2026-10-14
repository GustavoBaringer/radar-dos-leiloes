import { ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';

/** OpenAPI documentation DTO; HTTP parsing stays with the strict domain helper. */
export class CatalogSearchQueryDto {
  @ApiPropertyOptional() @Allow() q?: string;
  @ApiPropertyOptional({ type: [String] }) @Allow() uf?: string | string[];
  @ApiPropertyOptional({ type: [String] }) @Allow() status?: string | string[];
  @ApiPropertyOptional() @Allow() sellerType?: string | string[];
  @ApiPropertyOptional() @Allow() sourceId?: string | string[];
  @ApiPropertyOptional() @Allow() sourceSite?: string | string[];
  @ApiPropertyOptional() @Allow() auctioneer?: string | string[];
  @ApiPropertyOptional() @Allow() seller?: string | string[];
  @ApiPropertyOptional() @Allow() assetType?: string;
  @ApiPropertyOptional() @Allow() vehicleType?: string | string[];
  @ApiPropertyOptional() @Allow() propertyType?: string | string[];
  @ApiPropertyOptional() @Allow() city?: string | string[];
  @ApiPropertyOptional() @Allow() priceMin?: string;
  @ApiPropertyOptional() @Allow() priceMax?: string;
  @ApiPropertyOptional() @Allow() yearMin?: string;
  @ApiPropertyOptional() @Allow() yearMax?: string;
  @ApiPropertyOptional() @Allow() onlyWithDate?: string;
  @ApiPropertyOptional() @Allow() onlyWithPhoto?: string;
  @ApiPropertyOptional() @Allow() docType?: string | string[];
  @ApiPropertyOptional() @Allow() endsWithin?: string;
  @ApiPropertyOptional() @Allow() belowAppraisal?: string;
  @ApiPropertyOptional() @Allow() place?: string;
  @ApiPropertyOptional() @Allow() includeEnded?: string;
  @ApiPropertyOptional() @Allow() sort?: string;
  @ApiPropertyOptional() @Allow() page?: string;
  @ApiPropertyOptional() @Allow() pageSize?: string;
}
