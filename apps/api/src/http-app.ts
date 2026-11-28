import type {
  CallHandler,
  ExecutionContext,
  INestApplication,
  NestInterceptor,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { Express, Request, RequestHandler, Response } from 'express';
import pinoHttp from 'pino-http';
import { SESSION_COOKIE_NAME } from './core/auth/session-cookie';
import { loadSwaggerEnabled } from './core/config/config';
import { ProblemDetailsFilter, setApiCachePolicy } from './core/errors/problem-details.filter';
import { createRequestId } from './core/logging/http-request-id';
import { logger } from './core/logging/logger';

class ApiCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    setApiCachePolicy(http.getRequest<Request>().path, http.getResponse<Response>());
    return next.handle();
  }
}

const contentTypePolicy: RequestHandler = (_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

export function configureHttpApp(app: INestApplication): OpenAPIObject {
  const express = app.getHttpAdapter().getInstance() as Express;
  express.disable('x-powered-by');
  express.set('etag', false);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalInterceptors(new ApiCacheInterceptor());
  app.use(contentTypePolicy);
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
    .addCookieAuth(SESSION_COOKIE_NAME)
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  if (loadSwaggerEnabled()) {
    SwaggerModule.setup('api/docs', app, document);
  }
  return document;
}
