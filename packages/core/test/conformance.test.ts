import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { check, type Channel, type CheckResult } from "../src/index.js";
import { fetchFrom, whoisFrom, type Reply } from "./fake-fetch.js";
import { FIXTURES, INPUTS, type Fixture, type InputClass, type Service } from "./fixtures.js";

// Every channel goes through the same checks. A new channel only adds a fixture in fixtures.ts.

async function runOn(channel: Channel, name: string, service: Service) {
  const fetch = fetchFrom(service.http);
  const whois = whoisFrom(service.whois);
  const [result] = await check(name, [channel], { fetch, whois, backoffMs: 0 });
  return { result: result!, requests: [...fetch.calls, ...whois.calls.map((c) => `whois ${c}`)] };
}

/** Invariants every result must hold, whatever the channel or the response. */
function expectWellFormed(result: CheckResult, channel: Channel) {
  expect(result.channel).toBe(channel.id);
  expect(result.label).toBe(channel.label);
  if (result.status === "available") expect(result.certainty).toBeDefined();
  if (result.status === "taken" || result.status === "reclaimable") expect(result.url).toBeTruthy();
  if (result.status === "unknown" || result.status === "unavailable")
    expect(result.note).toBeTruthy();
  // The JSON contract: `url` and `note` are text whenever they are present.
  for (const key of ["url", "note"] as const) {
    if (key in result) expect(typeof result[key] === "string" && result[key]!.trim()).toBeTruthy();
  }
}

const confirmedFree = (r: CheckResult) => r.status === "available" && r.certainty === "confirmed";

const timeout = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
const HTTP_FAULTS: [string, () => Reply][] = [
  ["network error", () => new TypeError("fetch failed")],
  ["timeout", timeout],
  ["HTTP 500", () => 500],
  ["HTTP 503", () => 503],
  ["HTTP 429", () => 429],
  ["HTTP 403", () => 403],
  ["unreadable body", () => [200, "not the expected shape"]],
];
const WHOIS_FAULTS: [string, () => string | Error][] = [
  ["connection error", () => new Error("ECONNRESET")],
  ["timeout", timeout],
  ["unrecognized answer", () => "Your query limit was exceeded."],
];

describe.each(FIXTURES.map((f) => [f.channel.id, f] as const))("%s", (_id, fixture: Fixture) => {
  const { channel } = fixture;

  describe("input classes", () => {
    for (const [klass, name] of Object.entries(INPUTS) as [InputClass, string][]) {
      const accepted = fixture.accepts[klass];
      it(`${accepted ? "accepts" : "rejects"} ${klass} ${JSON.stringify(name)}`, async () => {
        const { result, requests } = await runOn(channel, name, fixture.free);
        expectWellFormed(result, channel);
        if (fixture.unchecked?.includes(klass)) {
          expect(result.status, JSON.stringify(result)).toBe("unknown");
        } else if (accepted) {
          expect(result.status, JSON.stringify(result)).toBe("available");
        } else {
          expect(result.status, JSON.stringify(result)).toBe("unavailable");
          if (!fixture.refusedAfterLookup?.includes(klass)) {
            expect(requests, "a rejected name must not reach the network").toEqual([]);
          }
        }
      });
    }

    if (fixture.maxLength) {
      const max = fixture.maxLength;
      it(`accepts a name of exactly ${max} characters and rejects ${max + 1}`, async () => {
        const at = await runOn(channel, "a".repeat(max), fixture.free);
        const over = await runOn(channel, "a".repeat(max + 1), fixture.free);
        expect(at.result.status, JSON.stringify(at.result)).toBe("available");
        expect(over.result.status, JSON.stringify(over.result)).toBe("unavailable");
        expect(over.requests).toEqual([]);
      });
    }
  });

  // The cases that a "404 means free" fake would never exercise.
  for (const refused of fixture.refused) {
    it(`refuses ${JSON.stringify(refused.name)} (${refused.why})`, async () => {
      const { result } = await runOn(channel, refused.name, refused.service ?? fixture.free);
      expectWellFormed(result, channel);
      expect(result.status, JSON.stringify(result)).toBe(refused.expect);
    });
  }

  it(`reaches ${fixture.freeCertainty} certainty for a free name when every request succeeds`, async () => {
    const { result } = await runOn(channel, INPUTS.typical, fixture.free);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "available",
      certainty: fixture.freeCertainty,
    });
  });

  it("reports a held name as taken, with a link", async () => {
    const { result } = await runOn(channel, INPUTS.typical, fixture.taken);
    expectWellFormed(result, channel);
    expect(result.status, JSON.stringify(result)).toBe("taken");
  });

  // Fault each request the free path makes, one at a time: a failure may lower certainty or yield
  // unknown, but it can never let the channel claim a name is confirmed free.
  describe("never confirms a name free when a request fails", async () => {
    const { requests } = await runOn(channel, INPUTS.typical, fixture.free);
    it("makes at least one request on the free path", () => {
      expect(requests.length).toBeGreaterThan(0);
    });
    for (const request of requests) {
      const isWhois = request.startsWith("whois ");
      for (const [fault, reply] of isWhois ? WHOIS_FAULTS : HTTP_FAULTS) {
        it(`${fault} on ${request}`, async () => {
          const faulted: Service = isWhois
            ? {
                ...fixture.free,
                whois: (s, q) =>
                  `whois ${s} ${q}` === request
                    ? (reply() as string | Error)
                    : fixture.free.whois(s, q),
              }
            : {
                ...fixture.free,
                http: (u, h) => (u === request ? (reply() as Reply) : fixture.free.http(u, h)),
              };
          const { result } = await runOn(channel, INPUTS.typical, faulted);
          expectWellFormed(result, channel);
          expect(confirmedFree(result), JSON.stringify(result)).toBe(false);
        });
      }
    }
  });

  it("holds its invariants for any name and any mix of responses", async () => {
    const reply = fc.oneof(
      fc.constant<Reply>(404),
      fc.constant<Reply>(500),
      fc.constant<Reply>(429),
      fc.constant<Reply>([200, {}]),
      fc.constant<Reply>(new TypeError("fetch failed")),
    );
    const name = fc.string({
      unit: fc.constantFrom(..."abcXYZ019-_.@/ é中".split("")),
      maxLength: 80,
    });
    await fc.assert(
      fc.asyncProperty(
        name,
        fc.array(reply, { minLength: 1, maxLength: 8 }),
        async (n, replies) => {
          // Each request gets one reply for the whole run, so a fault persists across retries.
          // A fault that a retry recovers from is not a failure and may still end in a confirmed answer.
          const assigned = new Map<string, Reply>();
          let failed = false;
          const replyFor = (key: string) => {
            if (!assigned.has(key)) assigned.set(key, replies[assigned.size % replies.length]!);
            return assigned.get(key)!;
          };
          const service: Service = {
            http: (u, h) => {
              const r = replyFor(u);
              if (r === 404 || (Array.isArray(r) && r[0] === 200)) return fixture.free.http(u, h);
              failed = true;
              return r;
            },
            whois: (s, q) => {
              const r = replyFor(`whois ${s} ${q}`);
              if (r === 404 || Array.isArray(r)) return fixture.free.whois(s, q);
              failed = true;
              return r instanceof Error ? r : "garbled";
            },
          };
          const { result, requests } = await runOn(channel, n, service);
          expectWellFormed(result, channel);
          // Without `refusedAfterLookup`, nothing is refused after a request.
          if (result.status === "unavailable" && !fixture.refusedAfterLookup) {
            expect(requests).toEqual([]);
          }
          if (failed) expect(confirmedFree(result), JSON.stringify(result)).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });
});
