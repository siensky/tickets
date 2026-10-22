/**
 * Fastify-modulutökning: `request.queueAuth` sätts av
 * `createRequireAdmittedQueueToken`s preHandler (controllers/
 * queue-controller.ts) och läses av route-handlern som kör bakom den
 * — en typad väg mellan de två i stället för att gissa på `unknown`.
 */
import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    queueAuth?: {
      readonly queueTokenId: string;
      readonly eventId: string;
    };
    auth0User?: {
      readonly auth0Sub: string;
      readonly email: string;
      readonly name: string | undefined;
    };
  }
}
