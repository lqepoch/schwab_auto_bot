import { z } from 'zod';

export const StreamerInfoSchema = z.object({
  streamerSocketUrl: z.string().url(),
  schwabClientCustomerId: z.string().min(1),
  schwabClientCorrelId: z.string().min(1),
  schwabClientChannel: z.string().min(1),
  schwabClientFunctionId: z.string().min(1),
});
