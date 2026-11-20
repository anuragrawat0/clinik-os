import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import pinoHttp from 'pino-http';
import { ProblemDetailsFilter } from './core/errors/problem-details.filter';
import { createRequestId } from './core/logging/http-request-id';
import { logger } from './core/logging/logger';

export function configureHttpApp(app: INestApplication): OpenAPIObject {
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.use(
    pinoHttp({
      logger,
      genReqId: createRequestId,
      serializers: {
        req(request) {
          return {
            id: request.id,
            method: request.method,
          };
        },
      },
      customLogLevel(_request, response, error) {
        if (error || response.statusCode >= 500) return 'error';
        if (response.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Clinik OS API')
    .setDescription('Clinik OS modular monolith API')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  if (process.env.NODE_ENV !== 'production') {
    SwaggerModule.setup('api/docs', app, document);
  }
  return document;
}
