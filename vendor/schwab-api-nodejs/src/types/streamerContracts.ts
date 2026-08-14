import { z } from 'zod';

export type StreamerFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'unknown';
export type StreamerDeliveryMode = 'change' | 'whole' | 'all-sequence';

type FieldEntry = readonly [string, StreamerFieldValueType];
type FieldMapFor<T extends readonly FieldEntry[]> = {
  readonly [Entry in T[number] as Entry[0]]: { readonly type: Entry[1] };
};

function defineFieldMap<const T extends readonly FieldEntry[]>(entries: T): FieldMapFor<T> {
  return Object.fromEntries(entries.map(([id, type]) => [id, { type }])) as FieldMapFor<T>;
}

export const LEVELONE_OPTIONS_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'string'], ['2', 'number'], ['3', 'number'], ['4', 'number'],
  ['5', 'number'], ['6', 'number'], ['7', 'number'], ['8', 'number'], ['9', 'number'],
  ['10', 'number'], ['11', 'number'], ['12', 'number'], ['13', 'number'], ['14', 'number'],
  ['15', 'number'], ['16', 'number'], ['17', 'number'], ['18', 'number'], ['19', 'number'],
  ['20', 'number'], ['21', 'string'], ['22', 'string'], ['23', 'number'], ['24', 'string'],
  ['25', 'number'], ['26', 'number'], ['27', 'number'], ['28', 'number'], ['29', 'number'],
  ['30', 'number'], ['31', 'number'], ['32', 'number'], ['33', 'string'], ['34', 'number'],
  ['35', 'number'], ['36', 'string'], ['37', 'number'], ['38', 'number'], ['39', 'number'],
  ['40', 'string'], ['41', 'string'], ['42', 'number'], ['43', 'string'], ['44', 'number'],
  ['45', 'number'], ['46', 'number'], ['47', 'number'], ['48', 'boolean'], ['49', 'string'],
  ['50', 'number'], ['51', 'number'], ['52', 'number'], ['53', 'number'], ['54', 'number'],
  ['55', 'string'],
] as const);

export const LEVELONE_FUTURES_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'number'], ['2', 'number'], ['3', 'number'], ['4', 'number'],
  ['5', 'number'], ['6', 'string'], ['7', 'string'], ['8', 'number'], ['9', 'number'],
  ['10', 'number'], ['11', 'number'], ['12', 'number'], ['13', 'number'], ['14', 'number'],
  ['15', 'string'], ['16', 'string'], ['17', 'string'], ['18', 'number'], ['19', 'number'],
  ['20', 'number'], ['21', 'string'], ['22', 'string'], ['23', 'number'], ['24', 'number'],
  ['25', 'number'], ['26', 'number'], ['27', 'string'], ['28', 'string'], ['29', 'string'],
  ['30', 'boolean'], ['31', 'number'], ['32', 'boolean'], ['33', 'number'], ['34', 'string'],
  ['35', 'number'], ['36', 'string'], ['37', 'number'], ['38', 'number'], ['39', 'boolean'],
  ['40', 'number'],
] as const);

export const LEVELONE_FUTURES_OPTIONS_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'number'], ['2', 'number'], ['3', 'number'], ['4', 'number'],
  ['5', 'number'], ['6', 'string'], ['7', 'string'], ['8', 'number'], ['9', 'number'],
  ['10', 'number'], ['11', 'number'], ['12', 'number'], ['13', 'number'], ['14', 'number'],
  ['15', 'string'], ['16', 'string'], ['17', 'number'], ['18', 'number'], ['19', 'number'],
  ['20', 'number'], ['21', 'number'], ['22', 'number'], ['23', 'number'], ['24', 'string'],
  ['25', 'number'], ['26', 'number'], ['27', 'string'], ['28', 'string'], ['29', 'string'],
  ['30', 'string'], ['31', 'string'],
] as const);

export const LEVELONE_FOREX_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'number'], ['2', 'number'], ['3', 'number'], ['4', 'number'],
  ['5', 'number'], ['6', 'number'], ['7', 'number'], ['8', 'number'], ['9', 'number'],
  ['10', 'number'], ['11', 'number'], ['12', 'number'], ['13', 'string'], ['14', 'string'],
  ['15', 'number'], ['16', 'number'], ['17', 'number'], ['18', 'string'], ['19', 'number'],
  ['20', 'string'], ['21', 'number'], ['22', 'number'], ['23', 'string'], ['24', 'string'],
  ['25', 'boolean'], ['26', 'string'], ['27', 'number'], ['28', 'number'], ['29', 'number'],
] as const);

export const BOOK_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'number'], ['2', 'array'], ['3', 'array'],
] as const);

export const CHART_EQUITY_SERVICE_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'number'], ['2', 'number'], ['3', 'number'], ['4', 'number'],
  ['5', 'number'], ['6', 'number'], ['7', 'number'], ['8', 'number'],
] as const);

export const CHART_FUTURES_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'number'], ['2', 'number'], ['3', 'number'], ['4', 'number'],
  ['5', 'number'], ['6', 'number'],
] as const);

// The local Schwab document defines the screener response envelope as indexes 0-4.
// Item attributes are named fields, not undocumented numeric selections; they are
// deliberately not invented here.
export const SCREENER_FIELDS = defineFieldMap([
  ['0', 'string'], ['1', 'number'], ['2', 'string'], ['3', 'number'], ['4', 'array'],
] as const);

export const ACCT_ACTIVITY_FIELDS = defineFieldMap([
  ['0', 'unknown'], ['1', 'string'], ['2', 'string'], ['3', 'string'],
] as const);

export const STREAMER_SERVICE_CONTRACTS = {
  LEVELONE_OPTIONS: { delivery: 'change', fields: LEVELONE_OPTIONS_FIELDS },
  LEVELONE_FUTURES: { delivery: 'change', fields: LEVELONE_FUTURES_FIELDS },
  LEVELONE_FUTURES_OPTIONS: { delivery: 'change', fields: LEVELONE_FUTURES_OPTIONS_FIELDS },
  LEVELONE_FOREX: { delivery: 'change', fields: LEVELONE_FOREX_FIELDS },
  NYSE_BOOK: { delivery: 'whole', fields: BOOK_FIELDS },
  NASDAQ_BOOK: { delivery: 'whole', fields: BOOK_FIELDS },
  OPTIONS_BOOK: { delivery: 'whole', fields: BOOK_FIELDS },
  CHART_EQUITY: { delivery: 'all-sequence', fields: CHART_EQUITY_SERVICE_FIELDS },
  CHART_FUTURES: { delivery: 'all-sequence', fields: CHART_FUTURES_FIELDS },
  SCREENER_EQUITY: { delivery: 'whole', fields: SCREENER_FIELDS },
  SCREENER_OPTION: { delivery: 'whole', fields: SCREENER_FIELDS },
  ACCT_ACTIVITY: { delivery: 'all-sequence', fields: ACCT_ACTIVITY_FIELDS },
} as const;

export type StreamerService = keyof typeof STREAMER_SERVICE_CONTRACTS;
export type ServiceFieldId<S extends StreamerService> = keyof typeof STREAMER_SERVICE_CONTRACTS[S]['fields'] & string;
export type ServiceFieldSelection<S extends StreamerService> = string | readonly ServiceFieldId<S>[];

type FieldMap = Record<string, { readonly type: StreamerFieldValueType }>;
type FieldValue<T extends StreamerFieldValueType> =
  T extends 'string' ? string
    : T extends 'number' ? number
      : T extends 'boolean' ? boolean
        : T extends 'array' ? unknown[]
          : unknown;

type ServiceFields<S extends StreamerService> = typeof STREAMER_SERVICE_CONTRACTS[S]['fields'];
type ServiceFieldValue<S extends StreamerService, Field extends keyof ServiceFields<S>> =
  ServiceFields<S>[Field] extends { readonly type: infer Type extends StreamerFieldValueType }
    ? FieldValue<Type>
    : unknown;

export type StreamerServiceRow<S extends StreamerService> = {
  key?: string;
  [field: string]: unknown;
} & {
  [Field in keyof ServiceFields<S>]?: ServiceFieldValue<S, Field>;
};

export interface TypedStreamerDataPayload<S extends StreamerService> {
  service: S;
  timestamp: number;
  command: string;
  content: Array<StreamerServiceRow<S>>;
  [key: string]: unknown;
}

export function serializeStreamerServiceFields<S extends StreamerService>(
  service: S,
  fields: ServiceFieldSelection<S> | undefined,
): string | undefined {
  if (fields === undefined) return undefined;
  const raw = typeof fields === 'string' ? fields.split(',') : [...fields];
  const definitions = STREAMER_SERVICE_CONTRACTS[service].fields as FieldMap;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const id = String(value).trim();
    if (!id || seen.has(id)) continue;
    if (!/^\d+$/.test(id) || !definitions[id]) {
      throw new Error(`${service} 不支持 Streamer field id: ${id}`);
    }
    seen.add(id);
    normalized.push(id);
  }
  if (normalized.length === 0) {
    throw new Error(`${service} fields must contain at least one supported field id`);
  }
  return normalized.join(',');
}

function fieldSchema(type: StreamerFieldValueType): z.ZodType {
  switch (type) {
    case 'string': return z.string();
    case 'number': return z.number().finite();
    case 'boolean': return z.boolean();
    case 'array': return z.array(z.unknown());
    default: return z.unknown();
  }
}

function rowSchema(fields: FieldMap): z.ZodType {
  const shape = Object.fromEntries(
    Object.entries(fields).map(([id, definition]) => [id, fieldSchema(definition.type).optional()]),
  );
  return z.object({ key: z.string().optional(), ...shape }).passthrough();
}

const SERVICE_ROW_SCHEMAS = Object.fromEntries(
  Object.entries(STREAMER_SERVICE_CONTRACTS).map(([service, contract]) => [service, rowSchema(contract.fields as FieldMap)]),
) as Record<StreamerService, z.ZodType>;

const SERVICE_PAYLOAD_ENVELOPE = z.object({
  service: z.string(),
  timestamp: z.number().finite(),
  command: z.string(),
  content: z.array(z.unknown()),
}).passthrough();

export function decodeStreamerServicePayload<S extends StreamerService>(
  service: S,
  payload: unknown,
): TypedStreamerDataPayload<S> {
  const envelope = SERVICE_PAYLOAD_ENVELOPE.parse(payload);
  if (envelope.service !== service) {
    throw new Error(`Streamer payload service mismatch: expected ${service}, received ${envelope.service}`);
  }
  const content = envelope.content.map((row) => SERVICE_ROW_SCHEMAS[service].parse(row));
  return { ...envelope, service, content } as TypedStreamerDataPayload<S>;
}

export function decodeStreamerServiceRow<S extends StreamerService>(
  service: S,
  row: unknown,
): StreamerServiceRow<S> {
  return SERVICE_ROW_SCHEMAS[service].parse(row) as StreamerServiceRow<S>;
}
