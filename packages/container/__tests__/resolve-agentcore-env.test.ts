import { describe, expect, it } from "vitest";
import { isParameterNotFoundError } from "../src/resolve-agentcore-env.js";

describe("resolve-agentcore-env", () => {
  it("detects SSM ParameterNotFound errors from AWS SDK metadata", () => {
    expect(isParameterNotFoundError({ name: "ParameterNotFound" })).toBe(true);
    expect(isParameterNotFoundError({ __type: "ParameterNotFound" })).toBe(true);
  });

  it("does not treat unrelated errors as missing optional parameters", () => {
    expect(isParameterNotFoundError({ name: "AccessDeniedException" })).toBe(false);
    expect(isParameterNotFoundError(new Error("boom"))).toBe(false);
    expect(isParameterNotFoundError(undefined)).toBe(false);
  });
});
