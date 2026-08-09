import { describe, it, expect, vi, afterEach } from "vitest";
import { alertPriceUnresolvedViaConsole } from "./alerts.js";

describe("alertPriceUnresolvedViaConsole", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a warning containing every identifying detail", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    alertPriceUnresolvedViaConsole({
      projectId: "33333333-3333-3333-3333-333333333333",
      provider: "anthropic",
      model: "some-unreleased-model",
      occurredAt: "2026-08-20T00:00:00.000Z",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toContain("anthropic");
    expect(message).toContain("some-unreleased-model");
    expect(message).toContain("2026-08-20T00:00:00.000Z");
    expect(message).toContain("33333333-3333-3333-3333-333333333333");
  });
});
