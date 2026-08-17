import { z } from 'zod';

const StreamerDataRowSchema = z
  .object({ key: z.string().optional() })
  .passthrough()
  .transform((value) => value as Record<string, unknown> & { key?: string });

export const StreamerCommandResponseSchema = z.object({
  service: z.string(),
  requestid: z.union([z.string(), z.number()]).transform(String),
  command: z.string(),
  timestamp: z.coerce.number(),
  content: z.object({
    // Accept the numeric and numeric-string wire forms documented by Schwab,
    // but never coerce null, empty strings, decimals, or NaN into success.
    code: z.union([
      z.number().int().finite(),
      z.string().regex(/^-?\d+$/).transform(Number),
    ]),
    msg: z.string(),
  }),
}).passthrough();

export type StreamerCommandResponse = z.infer<typeof StreamerCommandResponseSchema>;

/**
 * Streamer uses command-specific success codes in addition to the generic
 * zero-success response used by some environments and older fixtures.
 */
export function isSuccessfulStreamerCommand(service: string, command: string, code: number): boolean {
  if (!Number.isInteger(code) || !Number.isFinite(code)) return false;
  if (code === 0) return true;
  switch (command) {
    case 'SUBS': return code === 26;
    case 'UNSUBS': return code === 27;
    case 'ADD': return code === 28;
    case 'VIEW': return code === 29;
    default: return false;
  }
}

export const StreamerDataPayloadSchema = z.object({
  service: z.string(),
  timestamp: z.coerce.number(),
  command: z.string(),
  content: z.array(StreamerDataRowSchema),
}).passthrough();

export type StreamerDataPayload = z.infer<typeof StreamerDataPayloadSchema>;

export const StreamerNotifyPayloadSchema = z.object({
  heartbeat: z.string().optional(),
}).passthrough();

export type StreamerNotifyPayload = z.infer<typeof StreamerNotifyPayloadSchema>;

export const StreamerMessageSchema = z.object({
  response: StreamerCommandResponseSchema.array().optional(),
  data: StreamerDataPayloadSchema.array().optional(),
  notify: StreamerNotifyPayloadSchema.array().optional(),
}).passthrough();

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
