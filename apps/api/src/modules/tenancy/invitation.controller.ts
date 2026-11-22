import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public, readSessionCookie, setSessionCookie } from '../../core/auth';
import { ClientIpResolver, requestMetaFrom } from '../identity/core';
import { AcceptInvitationDto, InvitationPreviewDto } from './invitation.dto';
import { InvitationService } from './invitation.service';

@ApiTags('auth')
@Public()
@Controller('auth/invitations')
export class InvitationController {
  constructor(
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(ClientIpResolver) private readonly ipResolver: ClientIpResolver,
  ) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'token', type: String })
  @ApiOkResponse({ type: InvitationPreviewDto })
  @ApiResponse({ status: 404, description: 'Invitation unavailable' })
  preview(@Param('token') token: string): Promise<InvitationPreviewDto> {
    return this.invitations.preview(token);
  }

  @Post(':token/accept')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiParam({ name: 'token', type: String })
  @ApiBody({ type: AcceptInvitationDto, required: false })
  @ApiNoContentResponse()
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Invitation unavailable' })
  @ApiResponse({
    status: 422,
    description: 'Account details or a policy-compliant password required',
  })
  async accept(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const rawToken = await this.invitations.accept(
      token,
      body,
      readSessionCookie(req),
      requestMetaFrom(req, this.ipResolver),
    );
    setSessionCookie(res, rawToken);
  }
}
