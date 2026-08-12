export type CanonicalSubscriptionState = {
  service: string;
  keys: Set<string>;
  hasKeyParameter: boolean;
  parameters: Record<string, unknown>;
  generation: number;
};

export type SubscriptionMutation = {
  service: string;
  command: 'SUBS' | 'ADD' | 'VIEW' | 'UNSUBS';
  parameters?: Record<string, unknown>;
  previousState?: CanonicalSubscriptionState;
  generation: number;
};

export function cloneParameters(parameters?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (parameters === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  } catch {
    return { ...parameters };
  }
}

export function cloneState(state: CanonicalSubscriptionState | undefined): CanonicalSubscriptionState | undefined {
  if (!state) return undefined;
  return {
    service: state.service,
    keys: new Set(state.keys),
    hasKeyParameter: state.hasKeyParameter,
    parameters: cloneParameters(state.parameters) ?? {},
    generation: state.generation,
  };
}

export function readKeys(parameters?: Record<string, unknown>): string[] | undefined {
  if (!parameters || !Object.prototype.hasOwnProperty.call(parameters, 'keys')) return undefined;
  const raw = parameters.keys;
  if (typeof raw === 'string') return raw.split(',').map((key) => key.trim()).filter(Boolean);
  if (Array.isArray(raw)) {
    return raw
      .filter((key): key is string => typeof key === 'string')
      .flatMap((key) => key.split(',').map((item) => item.trim()).filter(Boolean));
  }
  return [];
}

export function withoutKeys(parameters?: Record<string, unknown>): Record<string, unknown> {
  const result = cloneParameters(parameters) ?? {};
  delete result.keys;
  return result;
}

export function parametersForState(state: CanonicalSubscriptionState): Record<string, unknown> {
  const parameters = cloneParameters(state.parameters) ?? {};
  if (state.hasKeyParameter) parameters.keys = [...state.keys].join(',');
  return parameters;
}


export function applySubscriptionMutation(
  states: Map<string, CanonicalSubscriptionState>,
  generations: Map<string, number>,
  command: 'SUBS' | 'ADD' | 'VIEW' | 'UNSUBS',
  service: string,
  parameters?: Record<string, unknown>,
): SubscriptionMutation {
  const previousState = cloneState(states.get(service));
  const generation = (generations.get(service) ?? 0) + 1;
  generations.set(service, generation);
  const clonedParameters = cloneParameters(parameters);

  if (command === 'UNSUBS') {
    applyUnsubscribeState(states, generations, service, clonedParameters);
  } else if (command === 'SUBS') {
    const keys = readKeys(clonedParameters);
    states.set(service, {
      service,
      keys: new Set(keys ?? []),
      hasKeyParameter: keys !== undefined,
      parameters: withoutKeys(clonedParameters),
      generation,
    });
  } else if (command === 'ADD') {
    const current = states.get(service);
    const keys = readKeys(clonedParameters);
    const nextKeys = new Set(current?.keys ?? []);
    for (const key of keys ?? []) nextKeys.add(key);
    states.set(service, {
      service,
      keys: nextKeys,
      hasKeyParameter: current?.hasKeyParameter === true || keys !== undefined,
      parameters: {
        ...(current?.parameters ?? {}),
        ...withoutKeys(clonedParameters),
      },
      generation,
    });
  } else {
    const current = states.get(service);
    states.set(service, {
      service,
      keys: new Set(current?.keys ?? []),
      hasKeyParameter: current?.hasKeyParameter ?? false,
      parameters: {
        ...(current?.parameters ?? {}),
        ...withoutKeys(clonedParameters),
      },
      generation,
    });
  }

  return {
    service,
    command,
    parameters: clonedParameters,
    previousState,
    generation,
  };
}

function applyUnsubscribeState(
  states: Map<string, CanonicalSubscriptionState>,
  generations: Map<string, number>,
  service: string,
  parameters?: Record<string, unknown>,
): void {
  const current = states.get(service);
  if (!current) return;
  const keys = readKeys(parameters);
  if (keys === undefined) {
    states.delete(service);
    return;
  }
  for (const key of keys) current.keys.delete(key);
  if (current.hasKeyParameter && current.keys.size === 0) {
    states.delete(service);
    return;
  }
  current.generation = generations.get(service) ?? current.generation;
}
