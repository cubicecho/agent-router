import type { RouterSettings } from './defaults.ts';

// The router's settings are the host's row, which the host parses and hands over in its view (`ports.ts`). This is
// only the vocabulary this package reads them with.

/** What a request on `/v1` gets for a locked field, or a `stream_options` key the router doesn't read. */
export const UnlistedFields = { Refuse: 'refuse', Ignore: 'ignore' } as const satisfies Record<
  string,
  RouterSettings['unlistedFields']
>;
export type UnlistedFields = (typeof UnlistedFields)[keyof typeof UnlistedFields];
