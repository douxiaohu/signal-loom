import { vi } from "vitest";

import { safeStorage } from "../../src/lib/storage";

describe("safeStorage", () => {
  beforeEach(() => window.localStorage.clear());

  it("reads and writes like localStorage", () => {
    expect(safeStorage.get("k")).toBeNull();
    safeStorage.set("k", "v");
    expect(safeStorage.get("k")).toBe("v");
  });

  it("never throws when the browser blocks site data", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(safeStorage.get("k")).toBeNull();
    expect(() => safeStorage.set("k", "v")).not.toThrow();
  });
});
