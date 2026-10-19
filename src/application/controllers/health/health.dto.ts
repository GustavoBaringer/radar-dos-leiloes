import { ApiProperty } from '@nestjs/swagger';
import { IsBooleanString, IsOptional } from 'class-validator';

export class HealthQueryDto {
  @IsOptional()
  @IsBooleanString()
  verbose?: string;
}

export class HealthDto {
  @ApiProperty({ example: 'ok', enum: ['ok'] })
  status!: 'ok';
}
