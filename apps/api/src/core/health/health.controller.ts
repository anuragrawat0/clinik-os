import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { HealthResponse } from '@clinik/shared';
import { DATABASE, DatabaseConnection } from '../db/database.module';

class HealthResponseDto implements HealthResponse {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';

  @ApiProperty({ enum: ['ok'] })
  database!: 'ok';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly database: DatabaseConnection) {}

  @Get()
  @ApiOkResponse({ type: HealthResponseDto })
  async getHealth(): Promise<HealthResponse> {
    await this.database.check();
    return { status: 'ok', database: 'ok' };
  }
}
