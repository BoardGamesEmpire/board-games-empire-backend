import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { BullMQQueueDepthRecorder } from './bullmq-queue-depth-recorder.service';

/**
 * Registers the {@link BullMQQueueDepthRecorder} service. Import once
 * at the application root alongside `BullModule.forRoot` so the
 * recorder can discover every queue registered downstream:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     BullModule.forRootAsync({ ... telemetry: createBullMQTelemetry() ... }),
 *     BullMQQueueDepthRecorderModule,
 *     SomeFeatureModule, // registers queues via BullModule.registerQueue
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Idles when metrics export is not enabled (see {@link BullMQQueueDepthRecorder}
 * for the activation check), so importing this module in apps that
 * happen to have no queues at startup is harmless.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [BullMQQueueDepthRecorder],
})
export class BullMQQueueDepthRecorderModule {}
