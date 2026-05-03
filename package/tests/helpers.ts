// SPDX-License-Identifier: Apache-2.0 OR MIT

import { MockAgent, type MockInterceptor } from "undici";

/**
 * Create a MockAgent that routes all requests through `handler`.
 * Pass as `{ dispatcher }` in FetchOptions.
 */
export function mockFetch(
  handler: MockInterceptor.MockReplyOptionsCallback,
  times = 10,
): MockAgent & AsyncDisposable {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(() => true)
    .intercept({ path: () => true, method: () => true })
    .reply(handler)
    .times(times);
  return Object.assign(agent, {
    [Symbol.asyncDispose]: () => agent.close(),
  });
}

/**
 * Create a MockAgent that rejects all requests with an error.
 * Pass as `{ dispatcher }` in FetchOptions.
 */
export function mockFetchError(error: Error, times = 10): MockAgent & AsyncDisposable {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(() => true)
    .intercept({ path: () => true, method: () => true })
    .replyWithError(error)
    .times(times);
  return Object.assign(agent, {
    [Symbol.asyncDispose]: () => agent.close(),
  });
}
