// Test helper: install/restore a mock for the global `fetch` used by our lambda code
// to talk to the live FPL API (https://fantasy.premierleague.com/api/...).
//
// Usage:
//   const fetchMock = installFetchMock((url) => {
//     if (url.includes('bootstrap-static')) return jsonResponse(buildBootstrapStatic({ events: [...] }));
//     return null; // unmatched -> throws, surfaces test bugs instead of silently passing
//   });
//   ... run code under test ...
//   fetchMock.restore();

export function installFetchMock(router) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, options });
    const response = await router(urlStr, options);
    if (!response) {
      throw new Error(`[mock-fetch] No mock route matched for URL: ${urlStr}`);
    }
    return response;
  };

  return {
    calls,
    restore() {
      globalThis.fetch = original;
    }
  };
}

export function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => data
  };
}

// Builds a minimal but realistic bootstrap-static payload.
export function buildBootstrapStatic({ events = [], elements = [], teams = [], element_types = [] } = {}) {
  return { events, elements, teams, element_types };
}

// Builds a single FPL "event" (gameweek) object with sensible defaults.
export function buildEvent(id, overrides = {}) {
  return {
    id,
    name: `Gameweek ${id}`,
    is_current: false,
    is_previous: false,
    is_next: false,
    finished: false,
    data_checked: false,
    ...overrides
  };
}

// Builds a realistic 38-gameweek season's worth of events, all finished, none current
// (this is exactly what FPL's live bootstrap-static looks like once a season has ended).
export function buildPostSeasonEvents(totalGameweeks = 38) {
  const events = [];
  for (let id = 1; id <= totalGameweeks; id++) {
    events.push(buildEvent(id, { finished: true, data_checked: true, is_previous: id === totalGameweeks }));
  }
  return events;
}

// Builds a mid-season snapshot: gameweeks before `currentGw` are finished,
// `currentGw` is marked is_current, everything after is upcoming.
export function buildMidSeasonEvents(currentGw, totalGameweeks = 38) {
  const events = [];
  for (let id = 1; id <= totalGameweeks; id++) {
    events.push(buildEvent(id, {
      finished: id < currentGw,
      data_checked: id < currentGw,
      is_current: id === currentGw,
      is_previous: id === currentGw - 1,
      is_next: id === currentGw + 1
    }));
  }
  return events;
}
