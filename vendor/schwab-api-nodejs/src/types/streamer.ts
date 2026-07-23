import { z } from 'zod';

const StreamerDataRowSchema = z
  .record(z.string(), z.unknown())
  .and(z.object({ key: z.string().optional() }))
  .transform((value) => value as Record<string, unknown> & { key?: string });

export const StreamerCommandResponseSchema = z.object({
  service: z.string(),
  requestid: z.string(),
  command: z.string(),
  timestamp: z.coerce.number(),
  content: z.object({
    code: z.coerce.number(),
    msg: z.string(),
  }),
});

export type StreamerCommandResponse = z.infer<typeof StreamerCommandResponseSchema>;

export const StreamerDataPayloadSchema = z.object({
  service: z.string(),
  timestamp: z.coerce.number(),
  command: z.string(),
  content: z.array(StreamerDataRowSchema),
});

export type StreamerDataPayload = z.infer<typeof StreamerDataPayloadSchema>;

export const StreamerNotifyPayloadSchema = z.object({
  heartbeat: z.string().optional(),
});

export type StreamerNotifyPayload = z.infer<typeof StreamerNotifyPayloadSchema>;

export const StreamerMessageSchema = z.object({
  response: StreamerCommandResponseSchema.array().optional(),
  data: StreamerDataPayloadSchema.array().optional(),
  notify: StreamerNotifyPayloadSchema.array().optional(),
});

export type StreamerMessage = z.infer<typeof StreamerMessageSchema>;

export interface StreamerLoginRequest {
  service: 'ADMIN';
  command: 'LOGIN';
  requestid: string;
  SchwabClientCustomerId: string;
  SchwabClientCorrelId: string;
  parameters: {
    Authorization: string;
    SchwabClientChannel: string;
    SchwabClientFunctionId: string;
  };
}

export interface StreamerRequestEnvelope {
  requests: Array<StreamerLoginRequest | StreamerServiceRequest>;
}

export interface StreamerServiceRequest {
  service: string;
  command: 'SUBS' | 'UNSUBS' | 'ADD' | 'VIEW' | 'LOGOUT';
  requestid: string;
  SchwabClientCustomerId: string;
  SchwabClientCorrelId: string;
  parameters?: Record<string, unknown>;
}
