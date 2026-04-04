import { describe, expect, it } from "vitest";
import { sanitizeQueryForLogs } from "../src/gmail-tool.js";

describe("gmail-tool log sanitization", () => {
  it("redacts emails, token-like strings, and long digit runs", () => {
    const sanitized = sanitizeQueryForLogs(
      "from:zoown13@gmail.com refresh_token=abc123 bearerSecret 123456789012 after:2026/03/01",
    );

    expect(sanitized).not.toContain("zoown13@gmail.com");
    expect(sanitized).not.toContain("refresh_token=abc123");
    expect(sanitized).not.toContain("123456789012");
    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).toContain("after:2026/03/01");
  });
});
