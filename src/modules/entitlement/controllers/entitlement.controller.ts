import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AdminOnly, AuthUser, CurrentUser, FullAdminOnly, Public } from '../../../common/auth/auth.decorators';
import { ZodPipe } from '../../../common/http/zod.pipe';
import { appStoreNotificationSchema, appStoreSyncSchema, createRedeemCodeSchema, listRedeemCodesSchema, redeemSchema } from '../dto/entitlement.schemas';
import { AppStoreService } from '../services/appstore.service';
import { EntitlementService } from '../services/entitlement.service';

@Controller('v1/me')
export class MeEntitlementController {
  constructor(private readonly entitlements: EntitlementService, private readonly appStore: AppStoreService) {}

  @Post('subscriptions/appstore')
  @HttpCode(200)
  syncAppStore(@CurrentUser() user: AuthUser, @Body(new ZodPipe(appStoreSyncSchema, 'VALIDATION_FAILED')) body: z.infer<typeof appStoreSyncSchema>) {
    return this.appStore.syncTransaction(user.id, body.signedTransaction);
  }

  @Post('redeem')
  @HttpCode(200)
  redeem(@CurrentUser() user: AuthUser, @Body(new ZodPipe(redeemSchema, 'VALIDATION_FAILED')) body: z.infer<typeof redeemSchema>) {
    return this.entitlements.redeem(user.id, body.code);
  }
}

/** The URL set as both the production and sandbox Server Notifications URL in App Store Connect. */
@Public()
@Controller('v1/appstore')
export class AppStoreNotificationsController {
  constructor(private readonly appStore: AppStoreService) {}

  @Post('notifications')
  @HttpCode(200)
  notify(@Body(new ZodPipe(appStoreNotificationSchema, 'VALIDATION_FAILED')) body: z.infer<typeof appStoreNotificationSchema>) {
    return this.appStore.handleNotification(body.signedPayload);
  }
}

@AdminOnly()
@FullAdminOnly()
@Controller('admin/redeem-codes')
export class AdminRedeemCodesController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Get()
  list(@Query(new ZodPipe(listRedeemCodesSchema)) query: z.infer<typeof listRedeemCodesSchema>) {
    return this.entitlements.listCodes(query.page, query.perPage);
  }

  @Post()
  create(@Body(new ZodPipe(createRedeemCodeSchema)) body: z.infer<typeof createRedeemCodeSchema>) {
    return this.entitlements.createCode(body);
  }

  @Post(':code/disable')
  @HttpCode(200)
  disable(@Param('code') code: string) {
    return this.entitlements.disableCode(code);
  }
}
